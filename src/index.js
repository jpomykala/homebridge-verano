const axios = require('axios')

module.exports = (api) => {
  api.registerAccessory('VeranoAccessoryPlugin', VeranoAccessoryPlugin);
}

class VeranoAccessoryPlugin {

  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.isAuthorized = false;
    this.log.debug('Verano Accessory Plugin Loaded');

    this.Characteristic = this.api.hap.Characteristic;

    this.informationService = new this.api.hap.Service.AccessoryInformation()
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "Verano")
      .setCharacteristic(this.api.hap.Characteristic.Model, "VER-24 WiFi");

    this.name = config.name;

    this.thermostatService = new this.api.hap.Service.Thermostat(this.name);

    this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

    this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.thermostatService.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this));

    this.authorize();
  }

  getServices() {
    return [
      this.informationService,
      this.thermostatService,
    ];
  }

  handleCurrentHeatingCoolingStateGet() {
    this.log.debug('Triggered GET CurrentHeatingCoolingState');
    return this.getTiles()
      .then(this.extractMode)
      .then(statusId => {

        if (statusId === 1) {
          return this.Characteristic.CurrentHeatingCoolingState.COOL;
        }

        if (statusId === 0) {
          return this.Characteristic.CurrentHeatingCoolingState.HEAT;
        }

        return this.Characteristic.CurrentHeatingCoolingState.OFF;
      });
  }


  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateGet() {
    this.log.debug('Triggered GET TargetHeatingCoolingState');
    return this.getTiles()
      .then(this.extractMode)
      .then(statusId => {

        if (statusId === 1) {
          return this.Characteristic.TargetHeatingCoolingState.COOL;
        }

        if (statusId === 0) {
          return this.Characteristic.TargetHeatingCoolingState.HEAT;
        }

        return this.Characteristic.TargetHeatingCoolingState.OFF;
      });
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateSet(value) {
    this.log.debug('Triggered SET TargetHeatingCoolingState:', value);

    let targetStatusId = 0;
    if (value === this.Characteristic.TargetHeatingCoolingState.OFF) {
      targetStatusId = 0;
    }

    if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
      targetStatusId = 1;
    }

    if (value === this.Characteristic.TargetHeatingCoolingState.COOL) {
      targetStatusId = 0;
    }

    //verano 1 - heating, 0 - cooling
    const requestBody = [
      {
        ido: 138,
        params: targetStatusId,
        module_index: 0
      }
    ]
    axios.post('https://emodul.pl/send_control_data', requestBody, {
      headers: {
        'Cookie': this.sessionCookie
      },
      withCredentials: true
    }).then(response => response.data);
  }

  /**
   * Handle requests to get the current value of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureGet() {
    this.log.debug('Triggered GET CurrentTemperature');
    return this.getTiles()
      .then(this.extractCurrentTemperature);
  }


  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  handleTargetTemperatureGet() {
    this.log.debug('Triggered GET TargetTemperature');
    return this.getTiles()
      .then(this.extractTargetTemperature);
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  handleTargetTemperatureSet(targetTemperature) {
    this.log.debug('Triggered SET TargetTemperature:', targetTemperature);
    const requestBody = [
      {
        ido: 139,
        params: targetTemperature * 10,
        module_index: 0
      }
    ]
    axios.post('https://emodul.pl/send_control_data', requestBody, {
      headers: {
        'Cookie': this.sessionCookie
      },
      withCredentials: true
    }).then(response => response.data);
  }

  /**
   * Handle requests to get the current value of the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsGet() {
    this.log.debug('Triggered GET TemperatureDisplayUnits (NOP)');
    return this.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  /**
   * Handle requests to set the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsSet(value) {
    this.log.debug('Triggered SET TemperatureDisplayUnits:', value, "(NOP)");
  }

  getTiles() {

    this.log.debug('Getting tiles');
    if(!this.isAuthorized) {
      this.log.error('Not authorized, cannot get tiles, trying to authorize');
      this.authorize();
      return;
    }

    return axios.get('https://emodul.pl/frontend/module_data', {
      headers: {
        'Cookie': this.sessionCookie
      },
      withCredentials: true
    }).then(response => {
      const tiles = response.data.tiles;
      this.log.debug('Tiles', tiles);
      return tiles;
    })
      .catch(error => {
        this.log.error("Error during tiles fetch", error);
        this.isAuthorized = false;
        throw error;
      });
  };

  async extractTargetTemperature(tiles) {
    const foundTile = tiles.filter(tile => tile.id === 58)[0]
    return foundTile.params.widget1.value / 10
  };

  async extractCurrentTemperature(tiles) {
    const foundTile = tiles.filter(tile => tile.id === 58)[0]
    return foundTile.params.widget2.value / 10;
  }

  extractMode(tiles = []) {
    const foundTile = tiles.filter(tile => tile?.id === 61)?.[0]
    return foundTile?.params?.statusId || -1;
  }

  async authorize() {
    const requestBody = {
      username: this.config.username,
      password: this.config.password,
      rememberMe: true,
      languageId: 'en'
    };
    this.log.debug('Trying to authorize with user', requestBody.username);
    const loginResponse = await axios.post('https://emodul.pl/login', requestBody);
    this.log.debug('Login response', loginResponse);
    const cookies = loginResponse.headers['set-cookie'];
    this.sessionCookie = cookies.filter(cookie => cookie.includes('session'))[0];
    this.isAuthorized = true;
  }
}
