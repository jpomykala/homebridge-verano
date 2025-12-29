import { AccessoryConfig, AccessoryPlugin, API, Controller, Logging, Service, Characteristic } from 'homebridge';
import axios, { AxiosInstance } from 'axios';

module.exports = (api: API) => {
    api.registerAccessory('VeranoAccessoryPlugin', VeranoAccessoryPlugin);
};

interface VeranoAccessoryConfig extends AccessoryConfig {
    username: string;
    password: string;
    tileId?: number;                  // default: 58
    setpointIdo?: number;             // default: 139
    temperatureDivider?: number;      // default: 10
    offThresholdC?: number;           // default: 10
    minC?: number;                    // default: 10
    maxC?: number;                    // default: 30
    stepC?: number;                   // default: 0.5
    pollIntervalSec?: number;         // default: 30
}

interface TileWidget {
    value: number;
}

interface TileParams {
    widget1: TileWidget; // target
    widget2: TileWidget; // current
}

interface Tile {
    id: number;
    params: TileParams;
}

interface ModuleDataResponse {
    tiles: Tile[];
}

interface ThermostatState {
    currentTemperature: number;
    targetTemperature: number;
    heating: boolean;
}

export class VeranoAccessoryPlugin implements AccessoryPlugin {
    private readonly service: Service;
    private readonly informationService: Service;
    private readonly Characteristic: typeof Characteristic;

    private readonly cfg: Required<Pick<
      VeranoAccessoryConfig,
      | 'tileId'
      | 'setpointIdo'
      | 'temperatureDivider'
      | 'offThresholdC'
      | 'minC'
      | 'maxC'
      | 'stepC'
      | 'pollIntervalSec'
    >>;

    private axios: AxiosInstance;
    private sessionCookie: string = '';
    private isAuthorized = false;
    private pollTimer?: NodeJS.Timeout;
    private writeInFlight = false;
    private thermostatState: ThermostatState = {
        currentTemperature: 0,
        targetTemperature: 0,
        heating: false,
    };

    private readonly credentials: { username: string; password: string };
    private pendingSetTimer?: NodeJS.Timeout;
    private pendingTargetC?: number;
    private lastRequestedTargetC?: number;

    constructor(
      private readonly log: Logging,
      private readonly config: AccessoryConfig,
      private readonly api: API,
    ) {
        this.Characteristic = this.api.hap.Characteristic;

        // Extract credentials and validate presence
        const raw = this.config as Partial<VeranoAccessoryConfig>;
        if (!raw.username || !raw.password) {
            throw new Error('Missing required config: username and/or password');
        }
        this.credentials = { username: raw.username, password: raw.password };

        // Normalize config
        this.cfg = {
            tileId: raw.tileId ?? 58,
            setpointIdo: raw.setpointIdo ?? 139,
            temperatureDivider: raw.temperatureDivider ?? 10,
            offThresholdC: raw.offThresholdC ?? 10,
            minC: raw.minC ?? 10,
            maxC: raw.maxC ?? 30,
            stepC: raw.stepC ?? 0.5,
            pollIntervalSec: raw.pollIntervalSec ?? 30,
        };

        // Ensure initial targetTemperature respects min constraints to avoid HomeKit warnings
        this.thermostatState.targetTemperature = this.cfg.minC;

        // Axios instance with base URL and timeout
        this.axios = axios.create({
            baseURL: 'https://emodul.pl',
            timeout: 8000,
            withCredentials: true,
            validateStatus: (s) => s >= 200 && s < 500, // handle 401/403 gracefully
        });

        // Attach cookie if available
        this.axios.interceptors.request.use((req) => {
            if (this.sessionCookie) {
                req.headers = req.headers ?? {};
                (req.headers as any)['Cookie'] = this.sessionCookie;
            }
            return req;
        });

        // Basic 401 reauth and retry once
        this.axios.interceptors.response.use(
          (res) => res,
          (err) => Promise.reject(err),
        );

        this.informationService = new this.api.hap.Service.AccessoryInformation()
          .setCharacteristic(this.Characteristic.Manufacturer, 'Verano')
          .setCharacteristic(this.Characteristic.Model, 'VER-24 WiFi');

        this.service = new this.api.hap.Service.Thermostat(this.config.name);

        // Current Heating/Cooling State
        this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
          .onGet(() => {
              return this.thermostatState.heating
                ? this.Characteristic.CurrentHeatingCoolingState.HEAT
                : this.Characteristic.CurrentHeatingCoolingState.OFF;
          });

        // Target Heating/Cooling State (HEAT/OFF only)
        this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
          .setProps({ validValues: [
                  this.Characteristic.TargetHeatingCoolingState.OFF,
                  this.Characteristic.TargetHeatingCoolingState.HEAT,
              ]})
          .onGet(() => {
              return this.thermostatState.heating
                ? this.Characteristic.TargetHeatingCoolingState.HEAT
                : this.Characteristic.TargetHeatingCoolingState.OFF;
          })
          .onSet(async (value) => {
              const heat = value === this.Characteristic.TargetHeatingCoolingState.HEAT;
              // Turning off maps to sending the off threshold setpoint if device requires it
              if (!heat) {
                  await this.setTargetTemperatureC(this.cfg.offThresholdC);
              }
              this.thermostatState.heating = heat;
              this.pushStateToHomeKit();
          });

        // Current Temperature
        this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
          .setProps({ minStep: 0.1 })
          .onGet(() => {
              return this.thermostatState.currentTemperature;
          });

        // Target Temperature
        this.service.getCharacteristic(this.Characteristic.TargetTemperature)
          .setProps({
              minValue: this.cfg.minC,
              maxValue: this.cfg.maxC,
              minStep: this.cfg.stepC,
          })
          .onGet(() => {
              // Return a clamped value to never violate HomeKit constraints
              return this.clampAndStep(this.thermostatState.targetTemperature, this.cfg.minC, this.cfg.maxC, this.cfg.stepC);
          })
          .onSet(async (value) => {
              const v = this.clampAndStep(Number(value), this.cfg.minC, this.cfg.maxC, this.cfg.stepC);

              // Update local state & HomeKit immediately for responsive UI
              this.thermostatState.targetTemperature = v;
              this.thermostatState.heating = v > this.cfg.offThresholdC;
              // Track optimistic target to avoid flicker until server confirms
              this.lastRequestedTargetC = v;
              this.pushStateToHomeKit();

              // Debounce network write: wait up to 2s, then send the last value
              if (this.pendingSetTimer) {
                  clearTimeout(this.pendingSetTimer);
              }
              this.pendingTargetC = v;
              this.pendingSetTimer = setTimeout(async () => {
                  const finalValue = this.pendingTargetC;
                  this.pendingSetTimer = undefined;
                  this.pendingTargetC = undefined;
                  if (typeof finalValue === 'number') {
                      await this.setTargetTemperatureC(finalValue);
                  }
              }, 1000);
          });

        // Celsius only
        this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
          .onGet(() => this.Characteristic.TemperatureDisplayUnits.CELSIUS)
          .onSet(() => { /* no-op, force Celsius */ });

        // Defer network until platform is ready
        this.api.on('didFinishLaunching', async () => {
            try {
                await this.ensureSession();
                await this.refreshStateSafe();
                this.startPolling();
            } catch (e) {
                this.log.error('Startup failed:', (e as Error)?.message ?? e);
            }
        });

        // Cleanup on shutdown
        this.api.on('shutdown', () => {
            this.stopPolling();
        });
    }

    identify?(): void {
        this.log('Identify!');
    }

    getServices(): Service[] {
        return [this.informationService, this.service];
    }

    getControllers?(): Controller[] {
        return [];
    }

    // --- Helpers ---

    private async executeWithReauth<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (err) {
            const error = err as any;
            if (error?.response?.status === 401 || error?.response?.status === 403) {
                this.isAuthorized = false;
                await this.requestAuthorization();
                return operation();
            }
            throw err;
        }
    }

    private startPolling() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = setInterval(async () => {
            await this.refreshStateSafe();
        }, this.cfg.pollIntervalSec * 1000);
    }

    private stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    private clampAndStep(v: number, min: number, max: number, step: number) {
        const clamped = Math.min(Math.max(v, min), max);
        return Math.round(clamped / step) * step;
    }

    private async ensureSession() {
        if (this.isAuthorized && this.sessionCookie) return;
        await this.requestAuthorization();
    }

    private async requestAuthorization() {
        const body = {
            username: this.credentials.username,
            password: this.credentials.password,
            rememberMe: true,
            languageId: 'en',
        };
        this.log.info('Authorizing user', this.credentials.username);
        const res = await this.axios.post('/login', body).catch((e) => {
            this.isAuthorized = false;
            throw e;
        });

        if (res.status !== 200) {
            this.isAuthorized = false;
            throw new Error(`Authorization failed: HTTP ${res.status}`);
        }

        const setCookie = res.headers['set-cookie'] as string[] | undefined;
        const session = setCookie?.find((c) => /session/i.test(c));
        if (!session) {
            this.isAuthorized = false;
            throw new Error('Authorization failed: missing session cookie');
        }

        // Keep only the cookie key=value part
        this.sessionCookie = session.split(';')[0];
        this.isAuthorized = true;
        this.log.info('Authorized as', this.credentials.username);
    }

    private async fetchDataTiles(): Promise<Tile[]> {
        return this.executeWithReauth(async () => {
            const res = await this.axios.get<ModuleDataResponse>('/frontend/module_data');
            if (res.status !== 200) {
                throw new Error(`Tiles fetch failed: HTTP ${res.status}`);
            }
            return res.data.tiles;
        });
    }

    private async requestTemperatureChange(targetC: number) {
        const body = [
            {
                ido: this.cfg.setpointIdo,
                params: Math.round(targetC * this.cfg.temperatureDivider),
                module_index: 0,
            },
        ];

        return this.executeWithReauth(async () => {
            const res = await this.axios.post('/send_control_data', body);
            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Temperature change failed: HTTP ${res.status}`);
            }
            return res.data;
        });
    }

    private async requestThermostatState(): Promise<ThermostatState> {
        const tiles = await this.fetchDataTiles();
        const tile = tiles.find((t) => t.id === this.cfg.tileId);
        if (!tile) throw new Error(`Tile ${this.cfg.tileId} not found`);

        const targetC = tile.params.widget1.value / this.cfg.temperatureDivider;
        const currentC = tile.params.widget2.value / this.cfg.temperatureDivider;

        this.thermostatState = {
            currentTemperature: currentC,
            targetTemperature: targetC,
            heating: targetC > this.cfg.offThresholdC,
        };

        return this.thermostatState;
    }

    private async refreshStateSafe() {
        try {
            const fetched = await this.requestThermostatState();

            // Preserve optimistic target until the server echoes it back (handles slow backends)
            const expected = this.lastRequestedTargetC;
            const fetchedClamped = this.clampAndStep(fetched.targetTemperature, this.cfg.minC, this.cfg.maxC, this.cfg.stepC);
            const expectedClamped = expected !== undefined
                ? this.clampAndStep(expected, this.cfg.minC, this.cfg.maxC, this.cfg.stepC)
                : undefined;
            const serverMatches = expectedClamped !== undefined && Math.abs(fetchedClamped - expectedClamped) < this.cfg.stepC / 2;

            const shouldPreserveLocalTarget = Boolean(
                this.pendingSetTimer ||
                this.writeInFlight ||
                (expected !== undefined && !serverMatches),
            );

            const nextTarget = shouldPreserveLocalTarget
              ? this.thermostatState.targetTemperature
              : fetched.targetTemperature;

            const nextState: ThermostatState = {
                currentTemperature: fetched.currentTemperature,
                targetTemperature: nextTarget,
                heating: nextTarget > this.cfg.offThresholdC,
            };

            this.thermostatState = nextState;
            this.pushStateToHomeKit(nextState);

            // Once server matches, clear optimistic marker
            if (serverMatches) {
                this.lastRequestedTargetC = undefined;
            }
        } catch (e) {
            this.log.debug('Refresh failed:', (e as Error)?.message ?? e);
        }
    }

    private pushStateToHomeKit(state: ThermostatState = this.thermostatState) {
        const clampedTarget = this.clampAndStep(state.targetTemperature, this.cfg.minC, this.cfg.maxC, this.cfg.stepC);
        this.service.updateCharacteristic(this.Characteristic.CurrentTemperature, state.currentTemperature);
        this.service.updateCharacteristic(
          this.Characteristic.CurrentHeatingCoolingState,
          state.heating ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF,
        );
        this.service.updateCharacteristic(this.Characteristic.TargetTemperature, clampedTarget);
        this.service.updateCharacteristic(
          this.Characteristic.TargetHeatingCoolingState,
          state.heating ? this.Characteristic.TargetHeatingCoolingState.HEAT : this.Characteristic.TargetHeatingCoolingState.OFF,
        );
    }

    private async setTargetTemperatureC(targetC: number) {
        if (this.writeInFlight) {
            // Simple debounce: skip if a write is in progress
            this.log.debug('Skipping set, write in flight');
            return;
        }
        this.writeInFlight = true;
        const bounded = this.clampAndStep(targetC, this.cfg.minC, this.cfg.maxC, this.cfg.stepC);
        this.log.info('Setting target temperature to', `${bounded}°C`);
        // Track optimistic target
        this.lastRequestedTargetC = bounded;
        try {
            await this.ensureSession();
            await this.requestTemperatureChange(bounded);
            // Refresh from source of truth
            await this.refreshStateSafe();
        } finally {
            this.writeInFlight = false;
        }
    }
}
