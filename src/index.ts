import {AccessoryConfig, AccessoryPlugin, API, Controller, Logging, Service} from 'homebridge';
import axios from "axios";

module.exports = (api: API) => {
    api.registerAccessory('VeranoAccessoryPlugin', VeranoAccessoryPlugin);
}


export class VeranoAccessoryPlugin implements AccessoryPlugin {

    private readonly TEMPERATURE_DIVIDER: number = 10;
    private readonly TURN_ON_OFF_TEMPERATURE: number = 10;
    private readonly informationService: any;
    private readonly name: string;
    private readonly service: Service;

    private isOn: boolean;
    private isAuthorized: boolean;
    private sessionCookie: string;
    private Characteristic: any;

    constructor(
        private readonly log: Logging,
        private readonly config: AccessoryConfig,
        private readonly api: API,
    ) {
        this.log.debug('Verano accessory plugin initializing');
        this.log = log;
        this.config = config;
        this.name = config.name;
        this.api = api;
        this.isAuthorized = false;
        this.sessionCookie = '';
        this.isOn = false;

        this.Characteristic = this.api.hap.Characteristic;

        this.informationService = new this.api.hap.Service.AccessoryInformation()
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "Verano")
            .setCharacteristic(this.api.hap.Characteristic.Model, "VER-24 WiFi");

        this.service = new this.api.hap.Service.Thermostat(this.name);

        this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .on('get', (callback) => {
                const value = this.isOn ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;
                callback(null, value);
            });

        this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({
                minValue: this.Characteristic.TargetHeatingCoolingState.OFF,
                maxValue: this.Characteristic.TargetHeatingCoolingState.HEAT,
                validValues: [
                    this.Characteristic.TargetHeatingCoolingState.OFF,
                    this.Characteristic.TargetHeatingCoolingState.HEAT
                ]
            })
            .on('get', (callback) => {
                this.fetchTargetTemperature()
                    .then(targetTemperature => {
                        this.isOn = targetTemperature > this.TURN_ON_OFF_TEMPERATURE;
                        const value = this.isOn ? this.Characteristic.TargetHeatingCoolingState.HEAT : this.Characteristic.TargetHeatingCoolingState.OFF;
                        callback(null, value);
                    });
            })
            .on('set', (value, callback) => {
                this.isOn = value === this.Characteristic.TargetHeatingCoolingState.OFF;
                if (this.isOn) {
                    callback(null);
                    return;
                }
                this.log.info('Turning off');
                this.requestTemperatureChange(this.TURN_ON_OFF_TEMPERATURE)
                    .then(() => callback(null))
                    .catch(error => callback(error));


            });

        this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
            .on('get', (callback) => {
                this.log.debug('Triggered GET CurrentTemperature');
                this.fetchCurrentTemperature()
                    .then(currentTemperature => {
                        callback(null, currentTemperature);
                    })
                    .catch(error => {
                        this.log.error('Error during current temperature fetch', error);
                        callback(error);
                    });
            });

        this.service.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({
                minValue: 10,
                maxValue: 30,
                minStep: 0.5
            })
            .on('get', (callback) => {
                this.log.debug('Triggered GET TargetTemperature');
                this.fetchTargetTemperature()
                    .then(targetTemperature => {
                        callback(null, targetTemperature);
                    })
                    .catch(error => {
                        this.log.error('Error during current temperature fetch', error);
                        callback(error);
                    });
            })
            .on('set', (value, callback) => {
                this.log.debug('Triggered SET TargetTemperature:', value);
                this.requestTemperatureChange(value as number)
                    .then(() => callback(null))
                    .catch(error => callback(error));
            });

        this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
            .on('get', (callback) => {
                callback(null, this.Characteristic.TemperatureDisplayUnits.CELSIUS);
            })
            .on('set', (value, callback) => {
            });

        this.log.debug('Verano accessory plugin initialized');
        this.requestAuthorization();
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

    private async fetchTargetTemperature() {
        const tiles = await this.fetchDataTiles()
        const foundTile = tiles.filter(tile => tile.id === 58)[0]
        return foundTile.params.widget1.value / this.TEMPERATURE_DIVIDER
    }

    private async fetchCurrentTemperature() {
        const tiles = await this.fetchDataTiles()
        const foundTile = tiles.filter(tile => tile.id === 58)[0]
        return foundTile.params.widget2.value / this.TEMPERATURE_DIVIDER;
    }

    private async fetchDataTiles() {
        this.log.info('Fetching data tiles');
        if (!this.isAuthorized) {
            this.log.error('Not authorized, cannot get tiles, trying to authorize');
            await this.requestAuthorization();
        }

        const config = {
            headers: {
                'Cookie': this.sessionCookie
            },
            withCredentials: true
        };
        return axios
            .get('https://emodul.pl/frontend/module_data', config)
            .then(response => {
                const tiles = response.data.tiles;
                this.log.info("Fetched", tiles.length, "data tiles");
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
                this.log.info('Successfully authorized');
                const cookies = loginResponse.headers['set-cookie'];
                this.sessionCookie = cookies.filter(cookie => cookie.includes('session'))[0];
                this.isAuthorized = true;
                return loginResponse;
            })
            .catch(error => {
                this.log.error("Error during authorization", error);
                this.isAuthorized = false;
                throw error;
            });
    }

    private async requestTemperatureChange(targetTemperature: number) {
        this.log.info('Changing temperature to', targetTemperature);
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
            .then(response => response?.data)
            .catch(error => {
                this.log.error("Error during temperature change", error);
                throw error;
            })
    }

}
