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
        this.log = log;
        this.config = config;
        this.api = api;
        this.isAuthorized = false;
        this.log.debug('Verano accessory plugin initializing');
        this.Characteristic = this.api.hap.Characteristic;
        this.informationService = new this.api.hap.Service.AccessoryInformation()
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "Verano")
            .setCharacteristic(this.api.hap.Characteristic.Model, "VER-24 WiFi");
        this.name = config.name;
        this.heaterCooler = new this.api.hap.Service.HeaterCooler(this.name);
        this.heaterCooler.getCharacteristic(this.Characteristic.Active)
            .onGet(this.handleActiveGet.bind(this))
            .onSet(this.handleActiveSet.bind(this));
        this.heaterCooler.getCharacteristic(this.Characteristic.TargetHeaterCoolerState)
            .onGet(this.handleTargetTemperatureGet.bind(this))
            .onSet(this.handleTargetTemperatureSet.bind(this));
        this.heaterCooler.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
            .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
            .onSet(this.handleTemperatureDisplayUnitsSet.bind(this));
        this.heaterCooler.getCharacteristic(this.Characteristic.CurrentTemperature)
            .onGet(this.handleCurrentTemperatureGet.bind(this));
        this.sessionCookie = '';
        this.isOn = false;
        this.log.debug('Verano accessory plugin initialized');
        this.requestAuthorization();
    }
    identify() {
        throw new Error('Method not implemented.');
    }
    getServices() {
        throw new Error('Method not implemented.');
    }
    getControllers() {
        throw new Error('Method not implemented.');
    }
    async handleActiveGet() {
        const targetTemperature = await this.fetchTargetTemperature();
        this.isOn = targetTemperature > this.TURN_ON_OFF_TEMPERATURE;
        this.log.debug('Triggered GET Target Temperature:', targetTemperature, "isOn:", this.isOn);
        return this.isOn ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE;
    }
    async handleActiveSet(value) {
        this.log.debug('Triggered SET Active:', value);
        this.isOn = value === this.Characteristic.Active.ACTIVE;
        if (!this.isOn) {
            this.log.info('Turning off');
            await this.requestTemperatureChange(this.TURN_ON_OFF_TEMPERATURE);
        }
    }
    async handleCurrentTemperatureGet() {
        this.log.debug('Triggered GET CurrentTemperature');
        return await this.fetchCurrentTemperature();
    }
    async handleTargetTemperatureGet() {
        this.log.debug('Triggered GET TargetTemperature');
        return await this.fetchTargetTemperature();
    }
    async handleTargetTemperatureSet(targetTemperature) {
        this.log.debug('Triggered SET TargetTemperature:', targetTemperature);
        await this.requestTemperatureChange(targetTemperature);
    }
    handleTemperatureDisplayUnitsGet() {
        this.log.debug('Triggered GET TemperatureDisplayUnits (NOP)');
        return this.Characteristic.TemperatureDisplayUnits.CELSIUS;
    }
    handleTemperatureDisplayUnitsSet(value) {
        this.log.debug('Triggered SET TemperatureDisplayUnits (NOP):', value);
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
    async fetchDataTiles() {
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
        return axios_1.default
            .get('https://emodul.pl/frontend/module_data', config)
            .then(response => {
            const tiles = response.data.tiles;
            this.log.debug('Data tiles', tiles);
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
            .then(response => response === null || response === void 0 ? void 0 : response.data)
            .catch(error => {
            this.log.error("Error during temperature change", error);
            throw error;
        });
    }
}
exports.VeranoAccessoryPlugin = VeranoAccessoryPlugin;
//# sourceMappingURL=index.js.map