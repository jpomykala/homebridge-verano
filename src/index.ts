import { AccessoryConfig, AccessoryPlugin, API, Characteristic, Controller, Logging, Service } from 'homebridge';
import axios from 'axios';

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
}

interface ThermostatState {
    currentTemperature: number;
    targetTemperature: number;
    heating: boolean;
}

// HomeKit reads are answered from the cache; eModul is asked again at most this often
const REFRESH_INTERVAL_MS = 10 * 1000;
// eModul reports the old setpoint for a few seconds after a write; keep showing the written one meanwhile
const HOLD_AFTER_WRITE_MS = 60 * 1000;
// Turning HEAT on sets the target to the room temperature plus this much
const HEAT_ON_OFFSET_C = 3;

export class VeranoAccessoryPlugin implements AccessoryPlugin {

    private readonly informationService: Service;
    private readonly service: Service;
    private readonly Characteristic: typeof Characteristic;
    private readonly cfg: Required<Pick<
        VeranoAccessoryConfig,
        'username' | 'password' | 'tileId' | 'setpointIdo' | 'temperatureDivider' | 'offThresholdC' | 'minC' | 'maxC' | 'stepC'
    >>;

    private thermostatState: ThermostatState = {
        currentTemperature: 0,
        targetTemperature: 0,
        heating: false,
    };

    private hasState = false;
    private lastRefreshAt = 0;
    private refreshPromise?: Promise<void>;
    private heldTargetC?: number;
    private holdUntil = 0;

    private isAuthorized = false;
    private sessionCookie = '';

    constructor(
        private readonly log: Logging,
        private readonly config: AccessoryConfig,
        private readonly api: API,
    ) {
        this.log.info('Initializing VeranoAccessoryPlugin');
        const raw = config as Partial<VeranoAccessoryConfig>;
        this.cfg = {
            username: raw.username ?? '',
            password: raw.password ?? '',
            tileId: raw.tileId ?? 58,
            setpointIdo: raw.setpointIdo ?? 139,
            temperatureDivider: raw.temperatureDivider ?? 10,
            offThresholdC: raw.offThresholdC ?? 10,
            minC: raw.minC ?? 10,
            maxC: raw.maxC ?? 30,
            stepC: raw.stepC ?? 0.5,
        };
        this.thermostatState.targetTemperature = this.cfg.minC;

        this.requestAuthorization().catch(() => { /* logged, retried on the next request */ });

        this.Characteristic = this.api.hap.Characteristic;

        this.informationService = new this.api.hap.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Verano')
            .setCharacteristic(this.Characteristic.Model, 'VER-24 WiFi');

        this.service = new this.api.hap.Service.Thermostat(config.name);

        // GET CURRENT STATE
        this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.currentHeatingCoolingState(this.readState()));

        // GET TARGET STATE
        this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({
                validValues: [
                    this.Characteristic.TargetHeatingCoolingState.OFF,
                    this.Characteristic.TargetHeatingCoolingState.HEAT,
                ],
            })
            .onGet(() => this.targetHeatingCoolingState(this.readState()))
            .onSet(async (value) => {
                if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
                    if (this.thermostatState.heating) {
                        return;
                    }
                    // Stay above the off threshold, otherwise the heater would still count as off
                    const targetC = Math.max(
                        this.roundToStep(this.thermostatState.currentTemperature + HEAT_ON_OFFSET_C),
                        this.cfg.offThresholdC + this.cfg.stepC,
                    );
                    this.log.info('Turning on heating...');
                    await this.setTargetTemperature(targetC);
                    this.log.info('Heating turned on');
                    return;
                }
                this.log.info('Turning off heating...');
                await this.setTargetTemperature(this.cfg.offThresholdC);
                this.log.info('Heating turned off');
            });

        // GET TEMPERATURE
        this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
            .onGet(() => this.readState().currentTemperature);

        // GET TARGET TEMPERATURE
        this.service.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({
                minValue: this.cfg.minC,
                maxValue: this.cfg.maxC,
                minStep: this.cfg.stepC,
            })
            .onGet(() => this.clamp(this.readState().targetTemperature))
            .onSet(async (value) => {
                this.log.debug('Set TargetTemperature:', value);
                await this.setTargetTemperature(value as number);
            });

        this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
            .onGet(() => this.Characteristic.TemperatureDisplayUnits.CELSIUS)
            .onSet(() => { /* Celsius only */ });

        this.api.on('didFinishLaunching', () => this.refreshInBackground());
    }

    identify?(): void {
        this.log('Identify!');
    }

    getServices(): Service[] {
        return [
            this.informationService,
            this.service,
        ];
    }

    getControllers?(): Controller[] {
        return [];
    }

    // Answers HomeKit right away from the cache and refreshes it in the background
    private readState(): ThermostatState {
        this.refreshInBackground();
        if (!this.hasState) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return this.thermostatState;
    }

    private refreshInBackground() {
        if (this.refreshPromise || Date.now() - this.lastRefreshAt < REFRESH_INTERVAL_MS) {
            return;
        }
        this.lastRefreshAt = Date.now();
        this.refreshPromise = this.refreshState()
            .catch(() => { /* logged in fetchDataTiles */ })
            .finally(() => {
                this.refreshPromise = undefined;
            });
    }

    private async refreshState() {
        const fetched = await this.requestThermostatState();
        let targetTemperature = fetched.targetTemperature;
        if (this.heldTargetC !== undefined) {
            if (Math.abs(targetTemperature - this.heldTargetC) < 0.01 || Date.now() > this.holdUntil) {
                this.heldTargetC = undefined;
            } else {
                targetTemperature = this.heldTargetC;
            }
        }
        const next: ThermostatState = {
            currentTemperature: fetched.currentTemperature,
            targetTemperature: targetTemperature,
            heating: targetTemperature > this.cfg.offThresholdC,
        };
        const changed = !this.hasState
            || next.currentTemperature !== this.thermostatState.currentTemperature
            || next.targetTemperature !== this.thermostatState.targetTemperature
            || next.heating !== this.thermostatState.heating;
        this.thermostatState = next;
        this.hasState = true;
        if (changed) {
            this.log.info('Thermostat state:', next);
            this.pushStateToHomeKit();
        }
    }

    private async setTargetTemperature(targetTemperature: number) {
        await this.withHapError(() => this.requestTemperatureChange(targetTemperature));
        this.heldTargetC = targetTemperature;
        this.holdUntil = Date.now() + HOLD_AFTER_WRITE_MS;
        this.thermostatState = {
            ...this.thermostatState,
            targetTemperature: targetTemperature,
            heating: targetTemperature > this.cfg.offThresholdC,
        };
        this.pushStateToHomeKit();
    }

    private pushStateToHomeKit() {
        const state = this.thermostatState;
        this.service.updateCharacteristic(this.Characteristic.CurrentTemperature, state.currentTemperature);
        this.service.updateCharacteristic(this.Characteristic.TargetTemperature, this.clamp(state.targetTemperature));
        this.service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentHeatingCoolingState(state));
        this.service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.targetHeatingCoolingState(state));
    }

    private currentHeatingCoolingState(state: ThermostatState) {
        return state.heating
            ? this.Characteristic.CurrentHeatingCoolingState.HEAT
            : this.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    private targetHeatingCoolingState(state: ThermostatState) {
        return state.heating
            ? this.Characteristic.TargetHeatingCoolingState.HEAT
            : this.Characteristic.TargetHeatingCoolingState.OFF;
    }

    // Keeps values inside the range declared in setProps, so HomeKit doesn't warn about them
    private clamp(value: number) {
        return Math.min(Math.max(value, this.cfg.minC), this.cfg.maxC);
    }

    private roundToStep(value: number) {
        return this.clamp(Number((Math.round(value / this.cfg.stepC) * this.cfg.stepC).toFixed(2)));
    }

    // HomeKit shows "No Response" instead of an unhandled error
    private async withHapError<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    // Pure fetch: refreshState compares the result with the cached state
    private async requestThermostatState(): Promise<ThermostatState> {
        const tiles = await this.fetchDataTiles();
        const foundTile = tiles.filter(tile => tile.id === this.cfg.tileId)[0];
        if (!foundTile) {
            this.log.error(`Tile ${this.cfg.tileId} not found`);
            throw new Error(`Tile ${this.cfg.tileId} not found`);
        }
        const targetTemperature = foundTile.params.widget1.value / this.cfg.temperatureDivider;
        const currentTemperature = foundTile.params.widget2.value / this.cfg.temperatureDivider;
        return {
            currentTemperature: currentTemperature,
            targetTemperature: targetTemperature,
            heating: targetTemperature > this.cfg.offThresholdC,
        };
    }

    private async fetchDataTiles() {
        this.log.debug('Fetching data');
        if (!this.isAuthorized) {
            this.log.error('Not authorized, cannot get tiles, trying to authorize');
            await this.requestAuthorization();
        }

        const config = {
            headers: {
                'Cookie': this.sessionCookie,
            },
            withCredentials: true,
        };
        return axios
            .get('https://emodul.pl/frontend/module_data', config)
            .then(response => {
                this.log.debug('Successfully fetched data');
                return response.data.tiles;
            })
            .catch(error => {
                if (error.response) {
                    this.log.error('Error during tiles fetch');
                    this.log.error('Status:', error.response.status);
                    this.log.error('Response:');
                    this.log.error(error.response.data);
                } else {
                    this.log.error('Error during tiles fetch', error);
                }
                this.isAuthorized = false;
                throw error;
            });
    }

    private async requestAuthorization() {
        const requestBody = {
            username: this.cfg.username,
            password: this.cfg.password,
            rememberMe: true,
            languageId: 'en',
        };
        this.log.info('Trying to authorize with user', requestBody.username);
        return axios
            .post('https://emodul.pl/login', requestBody)
            .then(loginResponse => {
                this.log.info('Successfully authorized', requestBody.username);
                const cookies: string[] = loginResponse.headers['set-cookie'] ?? [];
                this.sessionCookie = cookies.filter(cookie => cookie.includes('session'))[0];
                this.isAuthorized = true;
                return loginResponse;
            })
            .catch(error => {
                this.log.error('Error during authorization', requestBody.username, error);
                this.isAuthorized = false;
                throw error;
            });
    }

    private async requestTemperatureChange(targetTemperature: number) {
        this.log.info('Changing temperature to', targetTemperature + '°C');
        const requestBody = [
            {
                ido: this.cfg.setpointIdo,
                params: targetTemperature * this.cfg.temperatureDivider,
                module_index: 0,
            },
        ];
        const config = {
            headers: {
                'Cookie': this.sessionCookie,
            },
            withCredentials: true,
        };
        return axios
            .post('https://emodul.pl/send_control_data', requestBody, config)
            .then(response => {
                this.log.info('Successfully changed temperature to', targetTemperature + '°C');
                return response?.data;
            })
            .catch(error => {
                this.log.error('Error during temperature change', error);
                throw error;
            });
    }

}
