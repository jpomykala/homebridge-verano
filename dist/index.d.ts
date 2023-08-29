import { AccessoryConfig, AccessoryPlugin, API, CharacteristicValue, Controller, ControllerServiceMap, Logging, Service } from 'homebridge';
export declare class VeranoAccessoryPlugin implements AccessoryPlugin {
    private readonly log;
    private readonly config;
    private readonly api;
    private readonly TEMPERATURE_DIVIDER;
    private readonly TURN_ON_OFF_TEMPERATURE;
    private readonly informationService;
    private readonly name;
    private readonly heaterCooler;
    private isOn;
    private isAuthorized;
    private sessionCookie;
    private Characteristic;
    constructor(log: Logging, config: AccessoryConfig, api: API);
    identify?(): void;
    getServices(): Service[];
    getControllers?(): Controller<ControllerServiceMap>[];
    handleActiveGet(): Promise<any>;
    handleActiveSet(value: CharacteristicValue): Promise<void>;
    handleCurrentTemperatureGet(): Promise<number>;
    handleTargetTemperatureGet(): Promise<number>;
    handleTargetTemperatureSet(targetTemperature: any): Promise<void>;
    handleTemperatureDisplayUnitsGet(): any;
    handleTemperatureDisplayUnitsSet(value: any): void;
    private fetchTargetTemperature;
    private fetchCurrentTemperature;
    private fetchDataTiles;
    private requestAuthorization;
    private requestTemperatureChange;
}
//# sourceMappingURL=index.d.ts.map