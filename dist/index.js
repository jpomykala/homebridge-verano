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
        this.thermostatState = {
            currentTemperature: 0,
            targetTemperature: 0,
            heating: false
        };
        this.log = log;
        this.log.info('Initializing VeranoAccessoryPlugin');
        this.config = config;
        this.name = config.name;
        this.api = api;
        this.isAuthorized = false;
        this.sessionCookie = '';
        this.requestAuthorization();
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
    async requestThermostatState() {
        const tiles = await this.fetchDataTiles();
        const foundTile = tiles.filter(tile => tile.id === 58)[0];
        const targetTemperature = foundTile.params.widget1.value / this.TEMPERATURE_DIVIDER;
        const currentTemperature = foundTile.params.widget2.value / this.TEMPERATURE_DIVIDER;
        this.thermostatState = {
            currentTemperature: currentTemperature,
            targetTemperature: targetTemperature,
            heating: targetTemperature > this.TURN_ON_OFF_TEMPERATURE
        };
        this.log.info('Thermostat state:', this.thermostatState);
        return this.thermostatState;
    }
    async fetchDataTiles() {
        this.log.debug('Fetching data');
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
        return axios_1.default
            .get('https://emodul.pl/frontend/module_data', config)
            .then(response => {
            this.log.debug('Successfully fetched data');
            return response.data.tiles;
        })
            .catch(error => {
            if (error.response) {
                this.log.error("Error during tiles fetch");
                this.log.error("Status:", error.response.status);
                this.log.error("Response:");
                this.log.error(error.response.data);
            }
            else {
                this.log.error("Error during tiles fetch", error);
            }
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
    async requestTemperatureChange(targetTemperature) {
        this.log.info('Changing temperature to', targetTemperature + '°C');
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
            this.log.info('Successfully changed temperature to', targetTemperature + '°C');
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