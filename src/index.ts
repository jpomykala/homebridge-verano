import {AccessoryConfig, AccessoryPlugin, API, Controller, Logging, Service} from 'homebridge';
import axios from "axios";

module.exports = (api: API) => {
    api.registerAccessory('VeranoAccessoryPlugin', VeranoAccessoryPlugin);
}

interface ThermostatState {
    currentTemperature: number;
    targetTemperature: number;
    heating: boolean;
}

export class VeranoAccessoryPlugin implements AccessoryPlugin {

    private readonly TEMPERATURE_DIVIDER: number = 10;
    private readonly TURN_ON_OFF_TEMPERATURE: number = 10;

    private readonly informationService: any;
    private readonly name: string;
    private readonly service: Service;
    private thermostatState: ThermostatState = {
        currentTemperature: 0,
        targetTemperature: 0,
        heating: false
    };
    private lastFetchTime: number = -1;

    private isAuthorized: boolean;
    private sessionCookie: string;
    private Characteristic: any;

    constructor(
        private readonly log: Logging,
        private readonly config: AccessoryConfig,
        private readonly api: API,
    ) {
        this.log = log;
        this.log.info('Verano accessory plugin initializing');
        this.config = config;
        this.name = config.name;
        this.api = api;
        this.isAuthorized = false;
        this.sessionCookie = '';

        this.requestThermostatState()
            .then(thermostatState => this.log.info('Fetched initial thermostat state', thermostatState))

        this.Characteristic = this.api.hap.Characteristic;

        this.informationService = new this.api.hap.Service.AccessoryInformation()
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "Verano")
            .setCharacteristic(this.api.hap.Characteristic.Model, "VER-24 WiFi");

        this.service = new this.api.hap.Service.Thermostat(this.name);

        // GET CURRENT STATE
        this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .on('get', (callback) => {
                this.log.debug('Get CurrentHeatingCoolingState');
                const heatingState = this.thermostatState.heating ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;
                callback(null, heatingState);
            });

        // GET TARGET STATE
        this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({
                validValues: [
                    this.Characteristic.TargetHeatingCoolingState.OFF,
                    this.Characteristic.TargetHeatingCoolingState.HEAT
                ]
            })
            .on('get', (callback) => {
                this.log.debug('Get TargetHeatingCoolingState');
                this.requestThermostatState()
                    .then(thermostatState => {
                        const heatingState = thermostatState.heating ? this.Characteristic.TargetHeatingCoolingState.HEAT : this.Characteristic.TargetHeatingCoolingState.OFF;
                        callback(null, heatingState);
                    })
                    .catch(error => callback(error));
            })
            .on('set', (value, callback) => {
                this.thermostatState.heating = value === this.Characteristic.TargetHeatingCoolingState.HEAT;
                if (this.thermostatState.heating) {
                    callback(null);
                    return;
                }
                this.log.info('Turning off heating...');
                this.requestTemperatureChange(this.TURN_ON_OFF_TEMPERATURE)
                    .then(() => {
                        this.log.info('Heating turned off');
                        callback(null);
                    })
                    .catch(error => callback(error));
            });

        // GET TEMPERATURE
        this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
            .on('get', (callback) => {
                this.log.debug('Get CurrentTemperature');
                this.requestThermostatState()
                    .then(thermostatState => callback(null, thermostatState.currentTemperature))
                    .catch(error => callback(error));
            });

        // GET TARGET TEMPERATURE
        this.service.getCharacteristic(this.Characteristic.TargetTemperature)
            .on('get', (callback) => {
                this.log.debug('Get TargetTemperature');
                this.requestThermostatState()
                    .then(thermostatState => callback(null, thermostatState.targetTemperature))
                    .catch(error => callback(error));
            })
            .on('set', (value, callback) => {
                this.log.debug('Set TargetTemperature:', value);
                this.requestTemperatureChange(value as number)
                    .then(() => callback(null))
                    .catch(error => callback(error));
            })
            .setProps({
                minValue: 10,
                maxValue: 30,
                minStep: 0.5
            });

        this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
            .on('get', (callback) => {
                callback(null, this.Characteristic.TemperatureDisplayUnits.CELSIUS);
            })
            .on('set', (value, callback) => {
            });
        this.log.info('Verano accessory plugin initialized');
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

    private async requestThermostatState() {
        const tiles = await this.fetchDataTiles();
        const foundTile = tiles.filter(tile => tile.id === 58)[0];
        const targetTemperature = foundTile.params.widget1.value / this.TEMPERATURE_DIVIDER;
        const currentTemperature = foundTile.params.widget2.value / this.TEMPERATURE_DIVIDER;
        this.thermostatState = {
            currentTemperature: currentTemperature,
            targetTemperature: targetTemperature,
            heating: targetTemperature > this.TURN_ON_OFF_TEMPERATURE
        };
        return this.thermostatState;
    }

    private async fetchDataTiles() {

        const currentTime = new Date().getTime();
        if (this.lastFetchTime > 0 && currentTime - this.lastFetchTime < 2500) {
            this.log.debug('Returning cached thermostat state', this.thermostatState);
            return this.thermostatState;
        }
        this.log.debug('Fetching data tiles...');
        this.lastFetchTime = currentTime;

        if (!this.isAuthorized) {
            this.log.error('Not authorized, cannot get tiles, trying to authorize');
            await this.requestAuthorization();
        }

        const config = {
            headers: {
                'Cookie': this.sessionCookie
            },
            withCredentials: true,
        };
        return axios
            .get('https://emodul.pl/frontend/module_data', config)
            .then(response => {
                const tiles = response.data.tiles;
                this.log.debug("Fetched", tiles.length, "data tiles");
                this.log.debug(tiles);
                return tiles;
            }).catch(error => {
                this.log.error("Error during tiles fetch", error);
                this.isAuthorized = false;
                throw error;
            });
    };

    private async requestAuthorization() {
        const requestBody = {
            username: this.config.username,
            password: this.config.password,
            rememberMe: true,
            languageId: 'en'
        };
        this.log.info('Trying to authorize with user', requestBody.username);
        return axios
            .post('https://emodul.pl/login', requestBody)
            .then(loginResponse => {
                this.log.info('Successfully authorized', requestBody.username);
                const cookies = loginResponse.headers['set-cookie'];
                this.sessionCookie = cookies.filter(cookie => cookie.includes('session'))[0];
                this.isAuthorized = true;
                return loginResponse;
            })
            .catch(error => {
                this.log.error("Error during authorization", requestBody.username, error);
                this.isAuthorized = false;
                throw error;
            });
    }

    private async requestTemperatureChange(targetTemperature: number) {
        this.log.info('Changing temperature to', targetTemperature + '°C');
        this.lastFetchTime = -1;
        const requestBody = [
            {
                ido: 139,
                params: targetTemperature * this.TEMPERATURE_DIVIDER,
                module_index: 0
            }
        ]
        const config = {
            headers: {
                'Cookie': this.sessionCookie
            },
            withCredentials: true
        };
        return axios
            .post('https://emodul.pl/send_control_data', requestBody, config)
            .then(response => {
                this.log.info('Successfully changed temperature to', targetTemperature + '°C');
                return response?.data;
            })
            .catch(error => {
                this.log.error("Error during temperature change", error);
                throw error;
            })
    }

}
