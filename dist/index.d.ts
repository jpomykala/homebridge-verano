import { AccessoryConfig, AccessoryPlugin, API, Controller, Logging, Service } from 'homebridge';
export declare class VeranoAccessoryPlugin implements AccessoryPlugin {
    private readonly log;
    private readonly config;
    private readonly api;
    private readonly TEMPERATURE_DIVIDER;
    private readonly TURN_ON_OFF_TEMPERATURE;
    private readonly informationService;
    private readonly name;
    private readonly service;
    private cachedState;
    private isOn;
    private isAuthorized;
    private sessionCookie;
    private Characteristic;
    constructor(log: Logging, config: AccessoryConfig, api: API);
    identify?(): void;
    getServices(): Service[];
    getControllers?(): Controller[];
    private fetchTargetTemperature;
    private fetchCurrentTemperature;
    private clearCache;
    private fetchDataTiles;
    private requestAuthorization;
    private requestTemperatureChange;
}
//# sourceMappingURL=index.d.ts.map