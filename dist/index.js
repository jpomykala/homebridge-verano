"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VeranoAccessoryPlugin = void 0;
const axios_1 = __importDefault(require("axios"));
module.exports = (api) => {
    api.registerAccessory('VeranoAccessoryPlugin', VeranoAccessoryPlugin);
};
class VeranoAccessoryPlugin {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.TEMPERATURE_DIVIDER = 10;
        this.TURN_ON_OFF_TEMPERATURE = 10;
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
            this.log.debug('Triggered GET CurrentHeatingCoolingState');
            const value = this.isOn ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;
            callback(null, value);
        });
        this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({
            validValues: [
                this.Characteristic.TargetHeatingCoolingState.OFF,
                this.Characteristic.TargetHeatingCoolingState.HEAT
            ]
        });
        this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .on('get', (callback) => {
            this.log.debug('Triggered GET TargetHeatingCoolingState');
            this.fetchTargetTemperature()
                .then(targetTemperature => {
                this.isOn = targetTemperature > this.TURN_ON_OFF_TEMPERATURE;
                const value = this.isOn ? this.Characteristic.TargetHeatingCoolingState.HEAT : this.Characteristic.TargetHeatingCoolingState.OFF;
                callback(null, value);
            });
        })
            .on('set', (value, callback) => {
            this.isOn = value === this.Characteristic.TargetHeatingCoolingState.HEAT;
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
            this.requestTemperatureChange(value)
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
        setInterval(() => {
            this.clearCache();
        }, 5000);
        this.log.debug('Verano accessory plugin initialized');
        this.requestAuthorization();
    }
    identify() {
        this.log('Identify!');
    }
    getServices() {
        return [
            this.informationService,
            this.service,
        ];
    }
    getControllers() {
        return [];
    }
    async fetchTargetTemperature() {
        const tiles = await this.fetchDataTiles();
        const foundTile = tiles.filter(tile => tile.id === 58)[0];
        return foundTile.params.widget1.value / this.TEMPERATURE_DIVIDER;
    }
    async fetchCurrentTemperature() {
        const tiles = await this.fetchDataTiles();
        const foundTile = tiles.filter(tile => tile.id === 58)[0];
        return foundTile.params.widget2.value / this.TEMPERATURE_DIVIDER;
    }
    clearCache() {
        this.cachedState = null;
    }
    async fetchDataTiles() {
        this.log.info('Fetching data tiles');
        if (this.cachedState) {
            this.log.info('Returning cached state');
            return this.cachedState;
        }
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
        return axios_1.default
            .get('https://emodul.pl/frontend/module_data', config)
            .then(response => {
            const tiles = response.data.tiles;
            this.log.info("Fetched", tiles.length, "data tiles");
            this.cachedState = tiles;
            return tiles;
        }).catch(error => {
            this.log.error("Error during tiles fetch", error);
            this.isAuthorized = false;
            throw error;
        });
    }
    ;
    async requestAuthorization() {
        const requestBody = {
            username: this.config.username,
            password: this.config.password,
            rememberMe: true,
            languageId: 'en'
        };
        this.log.info('Trying to authorize with user', requestBody.username);
        return axios_1.default
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
    async requestTemperatureChange(targetTemperature) {
        this.log.info('Changing temperature to', targetTemperature);
        const requestBody = [
            {
                ido: 139,
                params: targetTemperature * this.TEMPERATURE_DIVIDER,
                module_index: 0
            }
        ];
        const config = {
            headers: {
                'Cookie': this.sessionCookie
            },
            withCredentials: true
        };
        return axios_1.default
            .post('https://emodul.pl/send_control_data', requestBody, config)
            .then(response => {
            this.log.info('Successfully changed temperature');
            return response === null || response === void 0 ? void 0 : response.data;
        })
            .catch(error => {
            this.log.error("Error during temperature change", error);
            throw error;
        });
    }
}
exports.VeranoAccessoryPlugin = VeranoAccessoryPlugin;
//# sourceMappingURL=index.js.map