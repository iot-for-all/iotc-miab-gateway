import { Server, Plugin } from '@hapi/hapi';
import { Mqtt } from 'azure-iot-device-mqtt';
import {
    ModuleClient,
    Twin,
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import {
    arch as osArch,
    hostname as osHostname,
    platform as osPlatform,
    type as osType,
    release as osRelease,
    version as osVersion,
    cpus as osCpus,
    totalmem as osTotalMem,
    freemem as osFreeMem,
    loadavg as osLoadAvg
} from 'os';
import { HealthState } from '../services/health';
import { bind, defer, sleep } from '../utils';

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        iotCentral?: IIotCentralPluginModule;
    }
}

const PluginName = 'IotCentralPlugin';
const ModuleName = 'IotCentralPluginModule';
const defaultHealthCheckRetries = 3;

export const IotcOutputName = 'iotc';

export interface IDirectMethodResult {
    status: number;
    payload: any;
}

type DirectMethodFunction = (commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) => Promise<void>;

export interface IIotCentralPluginModuleOptions {
    initializeModule(): Promise<void>;
    onHandleModuleProperties(desiredProps: any): Promise<void>;
    onHandleDownstreamMessages?(inputName: string, message: IoTMessage): Promise<void>;
    onModuleConnect?(): void;
    onModuleDisconnect?(): void;
    onModuleClientError?(error: Error): void;
    onModuleReady(): Promise<void>;
    onHealth(): Promise<HealthState>;
}

export interface IIotCentralPluginModule {
    moduleId: string;
    deviceId: string;
    moduleClient: ModuleClient;
    debugTelemetry(): boolean;
    getHealth(): Promise<HealthState>;
    sendMessage(data: any, outputName?: string): Promise<void>;
    updateModuleProperties(properties: any): Promise<void>;
    addDirectMethod(directMethodName: string, directMethodFunction: DirectMethodFunction): void;
    invokeDirectMethod(moduleId: string, methodName: string, payload: any, connectTimeout?: number, responseTimeout?: number): Promise<IDirectMethodResult>;
}

export const iotCentralPluginModule: Plugin<any> = {
    name: 'IotCentralPluginModule',

    register: async (server: Server, options: IIotCentralPluginModuleOptions): Promise<void> => {
        server.log([PluginName, 'info'], 'register');

        if (!options.onHealth) {
            throw new Error('Missing required option onHealth in IoTCentralModuleOptions');
        }

        if (!options.onHandleModuleProperties) {
            throw new Error('Missing required option onHandleModuleProperties in IoTCentralModuleOptions');
        }

        if (!options.onModuleReady) {
            throw new Error('Missing required option onModuleReady in IoTCentralModuleOptions');
        }

        const plugin = new IotCentralPluginModule(server, options);

        server.settings.app.iotCentral = plugin;

        await plugin.startModule();
    }
};

interface ISystemProperties {
    cpuModel: string;
    cpuCores: number;
    cpuUsage: number;
    totalMemory: number;
    freeMemory: number;
}

enum IotcEdgeHostDevicePropNames {
    Hostname = 'hostname',
    ProcessorArchitecture = 'processorArchitecture',
    Platform = 'platform',
    OsType = 'osType',
    OsName = 'osName',
    TotalMemory = 'totalMemory',
    SwVersion = 'swVersion'
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum ModuleState {
    Inactive = 'inactive',
    Active = 'active'
}

interface IRestartGatewayModuleCommandRequestParams {
    timeout: number;
}

export interface IModuleCommandResponse {
    status: number;
    message: string;
    payload?: any;
}

enum IoTCentralModuleCapability {
    tlSystemHeartbeat = 'tlSystemHeartbeat',
    tlFreeMemory = 'tlFreeMemory',
    stIoTCentralClientState = 'stIoTCentralClientState',
    stModuleState = 'stModuleState',
    evModuleStarted = 'evModuleStarted',
    evModuleStopped = 'evModuleStopped',
    evModuleRestart = 'evModuleRestart',
    wpDebugTelemetry = 'wpDebugTelemetry',
    cmRestartGatewayModule = 'cmRestartGatewayModule'
}

interface IIoTCentralModuleSettings {
    [IoTCentralModuleCapability.wpDebugTelemetry]: boolean;
}

class IotCentralPluginModule implements IIotCentralPluginModule {
    private server: Server;
    private moduleTwin: Twin = null;
    private deferredStart = defer();
    private options: IIotCentralPluginModuleOptions;
    private healthCheckRetries: number = defaultHealthCheckRetries;
    private healthState = HealthState.Good;
    private healthCheckFailStreak = 0;
    private moduleSettings: IIoTCentralModuleSettings = {
        [IoTCentralModuleCapability.wpDebugTelemetry]: false
    };

    constructor(server: Server, options: IIotCentralPluginModuleOptions) {
        this.server = server;
        this.options = options;
    }

    public async startModule(): Promise<boolean> {
        let result = false;

        try {
            await this.options.initializeModule();

            for (let connectCount = 1; !result && connectCount <= 3; connectCount++) {
                result = await this.connectModuleClient();

                if (!result) {
                    this.server.log([ModuleName, 'error'], `Connect client attempt failed (${connectCount} of 3)${connectCount < 3 ? ' - retry in 5 seconds' : ''}`);
                    await sleep(5000);
                }
            }

            if (result) {
                await this.deferredStart.promise;

                await this.options.onModuleReady();

                this.healthCheckRetries = Number(process.env.healthCheckRetries) || defaultHealthCheckRetries;

                const systemProperties = await this.getSystemProperties();

                this.addDirectMethod(IoTCentralModuleCapability.cmRestartGatewayModule, this.handleDirectMethod);

                await this.updateModuleProperties({
                    [IotcEdgeHostDevicePropNames.ProcessorArchitecture]: osArch() || 'Unknown',
                    [IotcEdgeHostDevicePropNames.Hostname]: osHostname() || 'Unknown',
                    [IotcEdgeHostDevicePropNames.Platform]: osPlatform() || 'Unknown',
                    [IotcEdgeHostDevicePropNames.OsType]: osType() || 'Unknown',
                    [IotcEdgeHostDevicePropNames.OsName]: osRelease() || 'Unknown',
                    [IotcEdgeHostDevicePropNames.TotalMemory]: systemProperties.totalMemory || 0,
                    [IotcEdgeHostDevicePropNames.SwVersion]: osVersion() || 'Unknown'
                });

                await this.sendMessage({
                    [IoTCentralModuleCapability.stIoTCentralClientState]: IoTCentralClientState.Connected,
                    [IoTCentralModuleCapability.stModuleState]: ModuleState.Active,
                    [IoTCentralModuleCapability.evModuleStarted]: 'Module initialization'
                }, IotcOutputName);
            }
        }
        catch (ex) {
            result = false;

            this.server.log([ModuleName, 'error'], `Exception while starting IotCentralModule plugin: ${ex.message}`);
        }

        return result;
    }

    public moduleId: string = process.env.IOTEDGE_MODULEID || '';
    public deviceId: string = process.env.IOTEDGE_DEVICEID || '';
    public moduleClient: ModuleClient = null;

    public debugTelemetry(): boolean {
        return this.moduleSettings[IoTCentralModuleCapability.wpDebugTelemetry];
    }

    public async getHealth(): Promise<HealthState> {
        if (!this.moduleClient) {
            return this.healthState;
        }

        let healthState = this.healthState;

        try {
            if (healthState === HealthState.Good) {
                const healthTelemetry = {};
                const systemProperties = await this.getSystemProperties();
                const freeMemory = systemProperties?.freeMemory || 0;

                healthTelemetry[IoTCentralModuleCapability.tlFreeMemory] = freeMemory;

                // TODO:
                // Find the right threshold for this metric
                if (freeMemory === 0) {
                    healthState = HealthState.Critical;
                }
                else {
                    healthState = await this.options.onHealth();
                }

                healthTelemetry[IoTCentralModuleCapability.tlSystemHeartbeat] = healthState;

                await this.sendMessage(healthTelemetry, IotcOutputName);
            }

            this.healthState = healthState;
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error in healthState (may indicate a critical issue): ${ex.message}`);
            this.healthState = HealthState.Critical;
        }

        if (this.healthState < HealthState.Good) {
            this.server.log([ModuleName, 'warning'], `Health check warning: ${HealthState[healthState]}`);

            if (++this.healthCheckFailStreak >= this.healthCheckRetries) {
                this.server.log([ModuleName, 'warning'], `Health check too many warnings: ${healthState}`);

                await this.restartModule(0, 'checkHealthState');
            }
        }

        return this.healthState;
    }

    public async sendMessage(data: any, outputName?: string): Promise<void> {
        if (!data || !this.moduleClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            if (outputName) {
                await this.moduleClient.sendOutputEvent(outputName, iotcMessage);
            }
            else {
                await this.moduleClient.sendEvent(iotcMessage);
            }

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `sendMessage: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `sendMessage: ${ex.message}`);
        }
    }

    public async updateModuleProperties(properties: any): Promise<void> {
        if (!properties || !this.moduleTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.moduleTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve('');
                });
            });

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `Module properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error updating module properties: ${ex.message}`);
        }
    }

    public addDirectMethod(directMethodName: string, directMethodFunction: DirectMethodFunction): void {
        if (!this.moduleClient) {
            return;
        }

        this.moduleClient.onMethod(directMethodName, directMethodFunction);
    }

    public async invokeDirectMethod(moduleId: string, methodName: string, payload: any, connectTimeout?: number, responseTimeout?: number): Promise<IDirectMethodResult> {
        const directMethodResult: IDirectMethodResult = {
            status: 200,
            payload: {}
        };

        if (!this.moduleClient) {
            return directMethodResult;
        }

        try {
            const methodParams = {
                methodName,
                payload,
                connectTimeoutInSeconds: connectTimeout,
                responseTimeoutInSeconds: responseTimeout
            };

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `invokeModuleMethod request: ${JSON.stringify(methodParams, null, 4)}`);
            }

            const response = await this.moduleClient.invokeMethod(this.deviceId, moduleId, methodParams);

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `invokeModuleMethod response: ${JSON.stringify(response, null, 4)}`);
            }

            directMethodResult.status = response.status;
            directMethodResult.payload = response.payload || {};

            if (response.status < 200 || response.status > 299) {
                if (response.status === 102) {
                    this.server.log([ModuleName, 'warning'], `DirectMethod ${methodName} on module ${moduleId}, status: ${response.status} - waiting for completion`);
                }
                else {
                    this.server.log([ModuleName, 'error'], `Error executing directMethod ${methodName} on module ${moduleId}, status: ${response.status}`);
                }
            }
        }
        catch (ex) {
            directMethodResult.status = 500;
            this.server.log([ModuleName, 'error'], `Exception while calling invokeMethod: ${ex.message}`);
        }

        return directMethodResult;
    }

    private async connectModuleClient(): Promise<boolean> {
        let result = true;

        if (this.moduleClient) {
            if (this.moduleTwin) {
                this.moduleTwin.removeAllListeners();
            }

            if (this.moduleClient) {
                this.moduleClient.removeAllListeners();

                await this.moduleClient.close();
            }

            this.moduleClient = null;
            this.moduleTwin = null;
        }

        try {
            this.server.log([ModuleName, 'info'], `IOTEDGE_WORKLOADURI: ${process.env.IOTEDGE_WORKLOADURI} `);
            this.server.log([ModuleName, 'info'], `IOTEDGE_DEVICEID: ${process.env.IOTEDGE_DEVICEID} `);
            this.server.log([ModuleName, 'info'], `IOTEDGE_MODULEID: ${process.env.IOTEDGE_MODULEID} `);
            this.server.log([ModuleName, 'info'], `IOTEDGE_MODULEGENERATIONID: ${process.env.IOTEDGE_MODULEGENERATIONID} `);
            this.server.log([ModuleName, 'info'], `IOTEDGE_IOTHUBHOSTNAME: ${process.env.IOTEDGE_IOTHUBHOSTNAME} `);
            this.server.log([ModuleName, 'info'], `IOTEDGE_AUTHSCHEME: ${process.env.IOTEDGE_AUTHSCHEME} `);

            this.moduleClient = await ModuleClient.fromEnvironment(Mqtt);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Failed to instantiate client interface from configuration: ${ex.message} `);
        }

        if (!this.moduleClient) {
            return false;
        }

        try {
            this.moduleClient.on('connect', this.onModuleConnect);
            this.moduleClient.on('disconnect', this.onModuleDisconnect);
            this.moduleClient.on('error', this.onModuleClientError);

            this.server.log([ModuleName, 'info'], `Waiting for dependent modules to initialize(approx. 15s)...`);
            await sleep(15000);

            await this.moduleClient.open();

            this.server.log([ModuleName, 'info'], `Client is connected`);

            // TODO:
            // Should the module twin interface get connected *BEFORE* opening
            // the moduleClient above?
            this.moduleTwin = await this.moduleClient.getTwin();
            this.moduleTwin.on('properties.desired', this.onHandleModuleProperties);
            this.moduleClient.on('inputMessage', this.onHandleDownstreamMessages);

            this.server.log([ModuleName, 'info'], `IoT Central successfully connected module: ${process.env.IOTEDGE_MODULEID}, instance id: ${process.env.IOTEDGE_DEVICEID} `);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `IoT Central connection error: ${ex.message} `);

            result = false;
        }

        return result;
    }

    @bind
    private async onHandleModuleProperties(desiredChangedSettings: any): Promise<void> {
        if (!this.moduleClient) {
            return;
        }

        this.server.log([ModuleName, 'info'], `onHandleModuleProperties`);
        if (this.debugTelemetry()) {
            this.server.log([ModuleName, 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);
        }

        await this.options.onHandleModuleProperties(desiredChangedSettings);

        try {
            const patchedProperties = {};

            for (const setting in desiredChangedSettings) {
                if (!Object.prototype.hasOwnProperty.call(desiredChangedSettings, setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = desiredChangedSettings[setting];

                switch (setting) {
                    case IoTCentralModuleCapability.wpDebugTelemetry:
                        patchedProperties[setting] = {
                            value: this.moduleSettings[setting] = value || false,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    default:
                        this.server.log([ModuleName, 'warning'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }
            }

            if (Object.prototype.hasOwnProperty.call(patchedProperties, 'value')) {
                await this.updateModuleProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }

        this.deferredStart.resolve();
    }

    @bind
    private async onHandleDownstreamMessages(inputName: string, message: IoTMessage): Promise<void> {
        if (!this.moduleClient || !message) {
            return;
        }

        if (this.options.onHandleDownstreamMessages) {
            await this.options.onHandleDownstreamMessages(inputName, message);
        }
    }

    @bind
    private onModuleConnect() {
        if (this.options.onModuleConnect) {
            this.options.onModuleConnect();
        }
        else {
            this.server.log([ModuleName, 'info'], `The module received a connect event`);
        }
    }

    @bind
    private onModuleDisconnect() {
        if (this.options.onModuleDisconnect) {
            this.options.onModuleDisconnect();
        }
        else {
            this.server.log([ModuleName, 'info'], `The module received a disconnect event`);
        }
    }

    @bind
    private onModuleClientError(error: Error) {
        try {
            this.moduleClient = null;
            this.moduleTwin = null;

            if (this.options.onModuleClientError) {
                this.options.onModuleClientError(error);
            }
            else {
                this.server.log([ModuleName, 'error'], `Module client connection error: ${error.message} `);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Module client connection error: ${ex.message} `);
        }
    }

    @bind
    private async handleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([ModuleName, 'info'], `${commandRequest.methodName} command received`);

        const response: IModuleCommandResponse = {
            status: 200,
            message: ''
        };

        try {
            switch (commandRequest.methodName) {
                case IoTCentralModuleCapability.cmRestartGatewayModule:
                    await this.restartModule((commandRequest?.payload as IRestartGatewayModuleCommandRequestParams)?.timeout || 0, 'RestartModule command received');

                    response.status = 200;
                    response.message = 'Restart module request received';
                    break;

                default:
                    response.status = 400;
                    response.message = `An unknown method name was found: ${commandRequest.methodName}`;
            }

            this.server.log([ModuleName, 'info'], response.message);
        }
        catch (ex) {
            response.status = 400;
            response.message = `An error occurred executing the command ${commandRequest.methodName}: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        await commandResponse.send(200, response);
    }

    private async restartModule(timeout: number, reason: string): Promise<void> {
        this.server.log([ModuleName, 'info'], `restartModule`);

        try {
            await this.sendMessage({
                [IoTCentralModuleCapability.evModuleRestart]: reason,
                [IoTCentralModuleCapability.stModuleState]: ModuleState.Inactive,
                [IoTCentralModuleCapability.evModuleStopped]: 'Module restart'
            }, IotcOutputName);

            await sleep(1000 * timeout);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `${ex.message}`);
        }

        // let Docker restart our container after 5 additional seconds to allow responses to this method to return
        setTimeout(() => {
            this.server.log([ModuleName, 'info'], `Shutting down main process - module container will restart`);
            process.exit(1);
        }, 1000 * 5);
    }

    private async getSystemProperties(): Promise<ISystemProperties> {
        const cpus = osCpus();
        const cpuUsageSamples = osLoadAvg();

        return {
            cpuModel: cpus[0]?.model || 'Unknown',
            cpuCores: cpus?.length || 0,
            cpuUsage: cpuUsageSamples[0],
            totalMemory: osTotalMem() / 1024,
            freeMemory: osFreeMem() / 1024
        };
    }
}
