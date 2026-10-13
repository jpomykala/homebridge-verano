import { AccessoryConfig, AccessoryPlugin, API, Controller, Logging, Service, Characteristic } from 'homebridge';
import axios, { AxiosInstance, AxiosResponse } from 'axios';

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
    pollIntervalMin?: number;         // default: 5 minutes
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

// Debounce for HomeKit target writes (slider drags, mode + temperature sent together)
const WRITE_DEBOUNCE_MS = 1000;
// Minimum gap between on-demand refreshes triggered by HomeKit reads
const MIN_REFRESH_INTERVAL_MS = 30 * 1000;
// Keep trying to apply a HomeKit change for this long; after that HomeKit shows the real eModul value
const OPTIMISTIC_TARGET_TTL_MS = 5 * 60 * 1000;
// emodul.pl is a web frontend, a single request can take up to ~10 s
const REQUEST_TIMEOUT_MS = 20 * 1000;
// Delays between write attempts while eModul fails (the last one repeats)
const WRITE_RETRY_DELAYS_MS = [3, 10, 30, 60].map((s) => s * 1000);
// Delays between checks whether eModul applied an accepted write (the last one repeats)
const CONFIRM_DELAYS_MS = [5, 10, 20, 30, 60].map((s) => s * 1000);
// An accepted but still unconfirmed setpoint is sent again after this long
const RESEND_AFTER_MS = 2 * 60 * 1000;

const errorMessage = (e: unknown) => (e as Error)?.message ?? String(e);
const secondsSince = (t: number) => ((Date.now() - t) / 1000).toFixed(1);

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
      | 'pollIntervalMin'
    >>;

    private axios: AxiosInstance;
    private sessionCookie = '';
    private isAuthorized = false;
    private authPromise?: Promise<void>;
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
    private lastRequestedAt = 0;
    // Setpoint restored when HEAT is turned back on
    private lastHeatTargetC?: number;
    // Retries a failed write or re-checks an unconfirmed one until OPTIMISTIC_TARGET_TTL_MS runs out
    private reconcileTimer?: NodeJS.Timeout;
    private failedWrites = 0;
    private writeAcceptedAt = 0;
    // Last setpoint read from eModul, shown when a HomeKit change can't be applied
    private lastServerTargetC?: number;
    private refreshPromise?: Promise<void>;
    private lastRefreshAttemptAt = 0;
    private lastSuccessfulRefreshAt = 0;
    private consecutiveFailures = 0;
    private staleReported = false;

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
            pollIntervalMin: raw.pollIntervalMin ?? 5,
        };

        // Ensure initial targetTemperature respects min constraints to avoid HomeKit warnings
        this.thermostatState.targetTemperature = this.cfg.minC;

        // Axios instance with base URL and timeout
        this.axios = axios.create({
            baseURL: 'https://emodul.pl',
            timeout: REQUEST_TIMEOUT_MS,
            withCredentials: true,
            validateStatus: (s) => s >= 200 && s < 500, // 401/403 are handled in executeWithReauth
        });

        // Attach cookie if available
        this.axios.interceptors.request.use((req) => {
            if (this.sessionCookie) {
                req.headers = req.headers ?? {};
                req.headers['Cookie'] = this.sessionCookie;
            }
            return req;
        });

        this.informationService = new this.api.hap.Service.AccessoryInformation()
          .setCharacteristic(this.Characteristic.Manufacturer, 'Verano')
          .setCharacteristic(this.Characteristic.Model, 'VER-24 WiFi')
          .setCharacteristic(this.Characteristic.SerialNumber, `emodul-tile-${this.cfg.tileId}`);

        this.service = new this.api.hap.Service.Thermostat(this.config.name);

        // Current Heating/Cooling State
        this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
          .setProps({ validValues: [
                  this.Characteristic.CurrentHeatingCoolingState.OFF,
                  this.Characteristic.CurrentHeatingCoolingState.HEAT,
              ]})
          .onGet(() => this.currentHeatingCoolingState(this.readState()));

        // Target Heating/Cooling State (HEAT/OFF only)
        this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
          .setProps({ validValues: [
                  this.Characteristic.TargetHeatingCoolingState.OFF,
                  this.Characteristic.TargetHeatingCoolingState.HEAT,
              ]})
          .onGet(() => this.targetHeatingCoolingState(this.readState()))
          .onSet((value) => {
              const heat = value === this.Characteristic.TargetHeatingCoolingState.HEAT;
              if (heat === this.thermostatState.heating) {
                  // Scenes/automations often re-send the current mode; don't touch the setpoint
                  return;
              }

              if (!heat) {
                  // Turning off maps to sending the off threshold setpoint
                  this.applyTargetLocally(this.step(this.cfg.offThresholdC));
                  return;
              }

              // Restore the setpoint from before turning off; fall back to current temp + 2°C.
              // Either way stay above the off threshold.
              const restored = this.lastHeatTargetC ?? this.step(this.thermostatState.currentTemperature + 2);
              this.applyTargetLocally(Math.max(restored, this.step(this.cfg.offThresholdC + this.cfg.stepC)));
          });

        // Current Temperature
        this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
          .setProps({ minStep: 0.1 })
          .onGet(() => this.readState().currentTemperature);

        // Target Temperature
        this.service.getCharacteristic(this.Characteristic.TargetTemperature)
          .setProps({
              minValue: this.cfg.minC,
              maxValue: this.cfg.maxC,
              minStep: this.cfg.stepC,
          })
          // Return a clamped value to never violate HomeKit constraints
          .onGet(() => this.step(this.readState().targetTemperature))
          .onSet((value) => {
              const targetC = this.step(Number(value));
              const offPending = this.pendingSetTimer !== undefined
                && this.pendingTargetC !== undefined
                && this.pendingTargetC <= this.cfg.offThresholdC;
              if (offPending && targetC > this.cfg.offThresholdC) {
                  // Scenes send OFF together with a temperature; keep the heater off and
                  // remember the temperature for the next HEAT instead of turning it back on
                  this.log.info(`Keeping heater OFF, ${targetC}°C saved for the next HEAT`);
                  this.lastHeatTargetC = targetC;
                  // Revert the slider after HAP stores the written value
                  setImmediate(() => this.pushStateToHomeKit());
                  return;
              }
              this.applyTargetLocally(targetC);
          });

        // Celsius only
        this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
          .onGet(() => this.Characteristic.TemperatureDisplayUnits.CELSIUS)
          .onSet(() => { /* no-op, force Celsius */ });

        // Defer network until platform is ready
        this.api.on('didFinishLaunching', () => {
            // Start polling even if the first refresh fails, so we recover once the cloud is back
            this.startPolling();
            this.triggerBackgroundRefresh(true);
        });

        // Cleanup on shutdown
        this.api.on('shutdown', () => {
            this.stopPolling();
            if (this.pendingSetTimer) {
                clearTimeout(this.pendingSetTimer);
                this.pendingSetTimer = undefined;
            }
            this.clearReconcileTimer();
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

    // --- HomeKit state ---

    /**
     * Returns cached state for onGet handlers and kicks off a background refresh.
     * Throws "No Response" when we have never reached the cloud or the data is stale,
     * instead of showing HomeKit made-up values (e.g. 0°C).
     */
    private readState(): ThermostatState {
        this.triggerBackgroundRefresh();
        if (this.isStale()) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return this.thermostatState;
    }

    private currentHeatingCoolingState(state: ThermostatState) {
        // HEAT means "actively heating" in HomeKit; when the room has reached the target show it as idle
        return state.heating && state.currentTemperature < state.targetTemperature
          ? this.Characteristic.CurrentHeatingCoolingState.HEAT
          : this.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    private targetHeatingCoolingState(state: ThermostatState) {
        return state.heating
          ? this.Characteristic.TargetHeatingCoolingState.HEAT
          : this.Characteristic.TargetHeatingCoolingState.OFF;
    }

    private pushStateToHomeKit(state: ThermostatState = this.thermostatState) {
        this.service.updateCharacteristic(this.Characteristic.CurrentTemperature, state.currentTemperature);
        this.service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentHeatingCoolingState(state));
        this.service.updateCharacteristic(this.Characteristic.TargetTemperature, this.step(state.targetTemperature));
        this.service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.targetHeatingCoolingState(state));
    }

    /**
     * Updates local state and HomeKit immediately (optimistic UI), then schedules a debounced write.
     * onSet handlers return right away, so HomeKit never waits on (or times out because of) the cloud.
     */
    private applyTargetLocally(targetC: number) {
        this.thermostatState = {
            ...this.thermostatState,
            targetTemperature: targetC,
            heating: targetC > this.cfg.offThresholdC,
        };
        if (this.thermostatState.heating) {
            this.lastHeatTargetC = targetC;
        }
        // Track optimistic target to avoid flicker until server confirms
        this.lastRequestedTargetC = targetC;
        this.lastRequestedAt = Date.now();
        this.failedWrites = 0;
        this.clearReconcileTimer();
        this.pushStateToHomeKit();

        // Debounce network write: only the last value within the window is sent
        if (this.pendingSetTimer) {
            clearTimeout(this.pendingSetTimer);
        }
        this.pendingTargetC = targetC;
        this.pendingSetTimer = setTimeout(() => {
            this.pendingSetTimer = undefined;
            void this.flushPendingWrite();
        }, WRITE_DEBOUNCE_MS);
    }

    private async flushPendingWrite(): Promise<void> {
        if (this.writeInFlight) {
            // Picked up again when the current write finishes
            return;
        }
        const targetC = this.pendingTargetC;
        if (targetC === undefined) {
            return;
        }
        this.pendingTargetC = undefined;
        this.writeInFlight = true;
        const startedAt = Date.now();
        let failure: string | undefined;
        try {
            const attempt = this.failedWrites ? ` (attempt ${this.failedWrites + 1})` : '';
            this.log.info(`Setting target temperature to ${targetC}°C${attempt}`);
            await this.requestTemperatureChange(targetC);
            this.log.info(`eModul accepted ${targetC}°C in ${secondsSince(startedAt)} s, waiting for confirmation`);
        } catch (e) {
            failure = errorMessage(e);
        } finally {
            this.writeInFlight = false;
        }

        if (this.pendingSetTimer) {
            // A newer value is still being debounced; its timer will flush it
            return;
        }
        if (this.pendingTargetC !== undefined) {
            // A newer value arrived while we were writing
            return this.flushPendingWrite();
        }

        if (failure === undefined) {
            this.failedWrites = 0;
            this.writeAcceptedAt = Date.now();
            this.scheduleReconcile(this.delayWithinDeadline(CONFIRM_DELAYS_MS, 0), () => this.checkConfirmation(1));
            return;
        }

        // Resending the same setpoint is harmless if a "failed" attempt actually went through
        const delay = this.delayWithinDeadline(WRITE_RETRY_DELAYS_MS, this.failedWrites++);
        this.log.warn(`Setting ${targetC}°C failed (${failure}), retrying in ${Math.round(delay / 1000)} s`);
        this.scheduleReconcile(delay, () => {
            if (this.deadlinePassed()) {
                this.giveUp(`last error: ${failure}`);
                return;
            }
            this.pendingTargetC = this.lastRequestedTargetC;
            return this.flushPendingWrite();
        });
    }

    // Re-reads the state until eModul reports the requested setpoint; resends it if eModul seems to have dropped it
    private async checkConfirmation(attempt: number): Promise<void> {
        await this.refreshState();
        if (this.lastRequestedTargetC === undefined || this.pendingSetTimer || this.writeInFlight) {
            // Confirmed, settled by refreshStateSafe after the deadline, or superseded by a newer value
            return;
        }
        if (this.deadlinePassed()) {
            this.giveUp('eModul did not respond');
            return;
        }
        if (Date.now() - this.writeAcceptedAt > RESEND_AFTER_MS) {
            this.log.warn(`eModul has not applied ${this.lastRequestedTargetC}°C for `
              + `${RESEND_AFTER_MS / 60000} min, sending it again`);
            this.pendingTargetC = this.lastRequestedTargetC;
            return this.flushPendingWrite();
        }
        this.scheduleReconcile(this.delayWithinDeadline(CONFIRM_DELAYS_MS, attempt), () => this.checkConfirmation(attempt + 1));
    }

    // Stops trying and shows the last setpoint eModul reported, so HomeKit doesn't display a value the heater doesn't have
    private giveUp(reason: string) {
        const requested = this.lastRequestedTargetC;
        this.lastRequestedTargetC = undefined;
        this.clearReconcileTimer();
        this.log.error(`Could not set ${requested}°C within ${OPTIMISTIC_TARGET_TTL_MS / 60000} min (${reason})`);
        if (this.lastServerTargetC !== undefined) {
            this.log.info(`HomeKit shows the last setpoint reported by eModul: ${this.lastServerTargetC}°C`);
            this.thermostatState = {
                ...this.thermostatState,
                targetTemperature: this.lastServerTargetC,
                heating: this.lastServerTargetC > this.cfg.offThresholdC,
            };
            this.pushStateToHomeKit();
        }
        void this.refreshState();
    }

    private deadlinePassed() {
        return Date.now() - this.lastRequestedAt > OPTIMISTIC_TARGET_TTL_MS;
    }

    // Picks the next delay from a schedule, but never sleeps past the deadline (+1 s, so it has passed on wake-up)
    private delayWithinDeadline(delays: number[], attempt: number) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        const remaining = this.lastRequestedAt + OPTIMISTIC_TARGET_TTL_MS - Date.now();
        return Math.max(0, Math.min(delay, remaining + 1000));
    }

    private scheduleReconcile(delayMs: number, step: () => Promise<void> | void) {
        this.clearReconcileTimer();
        this.reconcileTimer = setTimeout(() => {
            this.reconcileTimer = undefined;
            // A newer HomeKit value starts over; nothing to do once confirmed or given up
            if (this.lastRequestedTargetC === undefined || this.pendingSetTimer || this.writeInFlight) {
                return;
            }
            void step();
        }, delayMs);
    }

    private clearReconcileTimer() {
        if (this.reconcileTimer) {
            clearTimeout(this.reconcileTimer);
            this.reconcileTimer = undefined;
        }
    }

    // --- Polling / refresh ---

    private startPolling() {
        this.stopPolling();
        this.pollTimer = setInterval(() => {
            this.triggerBackgroundRefresh(true);
        }, this.cfg.pollIntervalMin * 60 * 1000);
    }

    private stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    private triggerBackgroundRefresh(force = false) {
        // Trigger refresh in background without blocking the current request
        if (this.refreshPromise) {
            return;
        }
        // Opening the Home app reads every characteristic at once; don't hit the cloud for each
        if (!force && Date.now() - this.lastRefreshAttemptAt < MIN_REFRESH_INTERVAL_MS) {
            return;
        }
        void this.refreshState();
    }

    // Shares one in-flight fetch between polling, HomeKit reads and write confirmations
    private refreshState(): Promise<void> {
        if (!this.refreshPromise) {
            this.refreshPromise = this.refreshStateSafe().finally(() => {
                this.refreshPromise = undefined;
            });
        }
        return this.refreshPromise;
    }

    private isStale() {
        const staleAfterMs = 3 * this.cfg.pollIntervalMin * 60 * 1000;
        return !this.lastSuccessfulRefreshAt || Date.now() - this.lastSuccessfulRefreshAt > staleAfterMs;
    }

    private async refreshStateSafe() {
        this.lastRefreshAttemptAt = Date.now();
        let fetched: ThermostatState;
        try {
            fetched = await this.requestThermostatState();
        } catch (e) {
            this.reportRefreshFailure(e);
            return;
        }
        const firstRefresh = !this.lastSuccessfulRefreshAt;
        this.lastSuccessfulRefreshAt = Date.now();
        this.lastServerTargetC = fetched.targetTemperature;
        if (this.consecutiveFailures > 0) {
            this.log.info(`eModul is reachable again (after ${this.consecutiveFailures} failed attempts)`);
        }
        this.consecutiveFailures = 0;
        this.staleReported = false;

        // Preserve optimistic target until the server echoes it back (handles slow backends)
        const optimisticExpired = Date.now() - this.lastRequestedAt > OPTIMISTIC_TARGET_TTL_MS;
        const expected = optimisticExpired ? undefined : this.lastRequestedTargetC;
        const serverMatches = expected !== undefined
            && Math.abs(this.step(fetched.targetTemperature) - this.step(expected)) < this.cfg.stepC / 2;

        const shouldPreserveLocalTarget = Boolean(
            this.pendingSetTimer ||
            this.writeInFlight ||
            (expected !== undefined && !serverMatches),
        );

        const previousTarget = this.thermostatState.targetTemperature;
        const nextTarget = shouldPreserveLocalTarget
          ? previousTarget
          : fetched.targetTemperature;

        if (firstRefresh) {
            this.log.info(`Connected to eModul: room ${fetched.currentTemperature}°C, `
              + `setpoint ${fetched.targetTemperature}°C, heating ${fetched.heating ? 'ON' : 'OFF'}`);
        } else if (serverMatches) {
            this.log.info(`eModul confirmed ${expected}°C after ${secondsSince(this.lastRequestedAt)} s`);
        } else if (this.lastRequestedTargetC !== undefined && !shouldPreserveLocalTarget) {
            this.log.warn(`eModul did not confirm ${this.lastRequestedTargetC}°C within `
              + `${OPTIMISTIC_TARGET_TTL_MS / 60000} min and reports ${fetched.targetTemperature}°C; showing that in HomeKit`);
        } else if (!shouldPreserveLocalTarget && this.step(nextTarget) !== this.step(previousTarget)) {
            this.log.info(`Setpoint on eModul is ${nextTarget}°C (HomeKit showed ${previousTarget}°C)`);
        }
        this.log.debug(`Room ${fetched.currentTemperature}°C, setpoint ${nextTarget}°C`);

        this.thermostatState = {
            currentTemperature: fetched.currentTemperature,
            targetTemperature: nextTarget,
            heating: nextTarget > this.cfg.offThresholdC,
        };
        if (this.thermostatState.heating) {
            this.lastHeatTargetC = this.step(nextTarget);
        }
        this.pushStateToHomeKit();

        // Once server matches (or we gave up waiting), clear optimistic marker
        if (serverMatches || (optimisticExpired && !shouldPreserveLocalTarget)) {
            this.lastRequestedTargetC = undefined;
        }
    }

    // Warns once per outage instead of on every failed attempt
    private reportRefreshFailure(e: unknown) {
        this.consecutiveFailures++;
        const message = errorMessage(e);
        if (this.consecutiveFailures === 1) {
            this.log.warn(`Cannot read state from eModul: ${message}`);
        } else {
            this.log.debug(`Refresh failed (${this.consecutiveFailures} in a row): ${message}`);
        }
        if (!this.staleReported && this.isStale()) {
            this.staleReported = true;
            const since = this.lastSuccessfulRefreshAt
              ? `since ${new Date(this.lastSuccessfulRefreshAt).toLocaleTimeString()}`
              : 'since startup';
            this.log.error(`No data from eModul ${since}, HomeKit shows "No Response" until it is back`);
        }
    }

    // --- emodul.pl API ---

    private step(v: number) {
        const { minC: min, maxC: max, stepC: step } = this.cfg;
        const clamped = Math.min(Math.max(v, min), max);
        // toFixed avoids float artefacts like 21.900000000000002 for steps such as 0.1
        const stepped = Number((Math.round(clamped / step) * step).toFixed(2));
        return Math.min(Math.max(stepped, min), max);
    }

    /**
     * Runs a request with a valid session. Since validateStatus lets 4xx through,
     * auth failures are detected on the response and retried once after re-login.
     * Requests use maxRedirects: 0, so a redirect (the web frontend sending us to its login page)
     * counts as an expired session too, as does a body rejected by isValid (e.g. an HTML page with 200).
     */
    private async executeWithReauth<T>(
      operation: () => Promise<AxiosResponse<T>>,
      isValid: (res: AxiosResponse<T>) => boolean = () => true,
    ): Promise<AxiosResponse<T>> {
        if (!this.isAuthorized || !this.sessionCookie) {
            await this.authorize();
        }
        const res = await operation();
        const sessionLost = res.status === 401 || res.status === 403
          || (res.status >= 300 && res.status < 400)
          || (res.status === 200 && !isValid(res));
        if (!sessionLost) {
            return res;
        }
        this.log.debug(`Session expired (HTTP ${res.status}), re-authorizing`);
        this.isAuthorized = false;
        await this.authorize();
        return operation();
    }

    // Shares one in-flight login between concurrent refreshes and writes
    private authorize(): Promise<void> {
        if (!this.authPromise) {
            this.authPromise = this.requestAuthorization().finally(() => {
                this.authPromise = undefined;
            });
        }
        return this.authPromise;
    }

    private async requestAuthorization() {
        const body = {
            username: this.credentials.username,
            password: this.credentials.password,
            rememberMe: true,
            languageId: 'en',
        };
        this.log.debug('Authorizing user', this.credentials.username);
        this.isAuthorized = false;
        const res = await this.axios.post('/login', body);

        if (res.status !== 200) {
            throw new Error(`Authorization failed: HTTP ${res.status}`);
        }

        const setCookie = res.headers['set-cookie'] as string[] | undefined;
        const session = setCookie?.find((c) => /session/i.test(c));
        if (!session) {
            throw new Error('Authorization failed: missing session cookie');
        }

        // Keep only the cookie key=value part
        this.sessionCookie = session.split(';')[0];
        this.isAuthorized = true;
        this.log.info('Authorized as', this.credentials.username);
    }

    private async fetchDataTiles(): Promise<Tile[]> {
        const hasTiles = (r: AxiosResponse<ModuleDataResponse>) => Array.isArray(r.data?.tiles);
        const res = await this.executeWithReauth(
          () => this.axios.get<ModuleDataResponse>('/frontend/module_data', { maxRedirects: 0 }),
          hasTiles,
        );
        if (res.status !== 200) {
            throw new Error(`Tiles fetch failed: HTTP ${res.status}`);
        }
        if (!hasTiles(res)) {
            throw new Error('Tiles fetch failed: response has no tiles (eModul page changed?)');
        }
        return res.data.tiles;
    }

    private async requestTemperatureChange(targetC: number) {
        const body = [
            {
                ido: this.cfg.setpointIdo,
                params: Math.round(targetC * this.cfg.temperatureDivider),
                module_index: 0,
            },
        ];

        const res = await this.executeWithReauth(() => this.axios.post('/send_control_data', body, { maxRedirects: 0 }));
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Temperature change failed: HTTP ${res.status}`);
        }
        return res.data;
    }

    // Pure fetch: does not touch this.thermostatState, so refreshStateSafe can compare against local state
    private async requestThermostatState(): Promise<ThermostatState> {
        const tiles = await this.fetchDataTiles();
        const tile = tiles.find((t) => t.id === this.cfg.tileId);
        if (!tile) throw new Error(`Tile ${this.cfg.tileId} not found`);

        const targetC = tile.params.widget1.value / this.cfg.temperatureDivider;
        const currentC = tile.params.widget2.value / this.cfg.temperatureDivider;

        return {
            currentTemperature: currentC,
            targetTemperature: targetC,
            heating: targetC > this.cfg.offThresholdC,
        };
    }
}
