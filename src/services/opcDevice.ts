import { Server } from '@hapi/hapi';
import { IDeviceProvisionInfo } from './miabGateway';
import { HealthState } from './health';
import { Mqtt as IoTHubTransport } from 'azure-iot-device-mqtt';
import {
    Client as IoTDeviceClient,
    Twin,
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import { bind, defer, emptyObj } from '../utils';
import { IModuleCommandResponse } from 'src/plugins/iotCentralModule';
import { OpcWriter } from './opcWriter';

interface IClientConnectResult {
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

export enum OpcDeviceCapability {
    stIoTCentralClientState = 'stIoTCentralClientState',
    rpDeviceId = 'rpDeviceId',
    rpEndpointUrl = 'rpEndpointUrl',
    wpDebugTelemetry = 'wpDebugTelemetry',
    cmTurnOnIndicator = 'cmTurnOnIndicator',
    cmTurnOffIndicator = 'cmTurnOffIndicator'
}

interface IOpcDeviceSettings {
    [OpcDeviceCapability.wpDebugTelemetry]: boolean;
}

export class OpcDevice {
    private server: Server;
    private deviceProvisionInfoInternal: IDeviceProvisionInfo;
    private deviceClient: IoTDeviceClient;
    private deviceTwin: Twin;
    private opcWriter: OpcWriter;

    private deferredStart = defer();
    private healthState = HealthState.Good;

    private opcDeviceSettings: IOpcDeviceSettings = {
        [OpcDeviceCapability.wpDebugTelemetry]: false
    };

    constructor(server: Server, deviceProvisionInfo: IDeviceProvisionInfo) {
        this.server = server;
        this.deviceProvisionInfoInternal = deviceProvisionInfo;
    }

    public get deviceProvisionInfo(): IDeviceProvisionInfo {
        return this.deviceProvisionInfoInternal;
    }

    public async connectDeviceClient(dpsConnectionString: string): Promise<IClientConnectResult> {
        let clientConnectionResult: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        try {
            clientConnectionResult = await this.connectDeviceClientInternal(dpsConnectionString);

            if (clientConnectionResult.clientConnectionStatus) {
                await this.deferredStart.promise;

                await this.deviceReady();

                await this.sendMessage({
                    [OpcDeviceCapability.stIoTCentralClientState]: IoTCentralClientState.Connected
                });
            }
        }
        catch (ex) {
            clientConnectionResult.clientConnectionStatus = false;
            clientConnectionResult.clientConnectionMessage = `An error occurred while accessing the device twin properties`;

            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], `${clientConnectionResult.clientConnectionMessage}: ${ex.message}`);
        }

        return clientConnectionResult;
    }

    @bind
    public async getHealth(): Promise<number> {
        return this.healthState;
    }

    public async disconnect(): Promise<void> {
        this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `Deleting opc device instance for assetId: ${this.deviceProvisionInfo.deviceId}`);

        try {
            if (this.deviceTwin) {
                this.deviceTwin.removeAllListeners();
            }

            if (this.deviceClient) {
                this.deviceClient.removeAllListeners();

                await this.deviceClient.close();
            }

            this.deviceClient = null;
            this.deviceTwin = null;
        }
        catch (ex) {
            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], `Error while deleting opc device: ${this.deviceProvisionInfo.deviceId}`);
        }
    }

    public async sendOpcPublisherRuntimeEvent(_event: string, _messageJson?: any): Promise<void> {
        return;
    }

    public async processOpcData(data: any): Promise<void> {
        this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `processOpcData`);

        if (!data || !this.deviceClient) {
            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], `Missing data or client not connected`);
            return;
        }

        try {
            await this.sendMessage(data);
        }
        catch (ex) {
            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], `Error processing opc data message: ${ex.message}`);
        }
    }

    private debugTelemetry(): boolean {
        return this.opcDeviceSettings[OpcDeviceCapability.wpDebugTelemetry];
    }

    private async deviceReady(): Promise<void> {
        this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `Device (${this.deviceProvisionInfo.deviceId}) is ready`);

        await this.updateDeviceProperties({
            [OpcDeviceCapability.rpDeviceId]: this.deviceProvisionInfo.deviceId,
            [OpcDeviceCapability.rpEndpointUrl]: this.deviceProvisionInfo.opcPublisherNodesRequest.EndpointUrl
        });
    }

    @bind
    private async onHandleDeviceProperties(desiredChangedSettings: any): Promise<void> {
        try {
            this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `onHandleDeviceProperties`);
            if (this.debugTelemetry()) {
                this.server.log([this.deviceProvisionInfo.deviceId, 'info'], JSON.stringify(desiredChangedSettings, null, 4));
            }

            const patchedProperties = {};

            for (const setting in desiredChangedSettings) {
                if (!Object.prototype.hasOwnProperty.call(desiredChangedSettings, setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = Object.prototype.hasOwnProperty.call(desiredChangedSettings[setting], 'value')
                    ? desiredChangedSettings[setting].value
                    : desiredChangedSettings[setting];

                switch (setting) {
                    case OpcDeviceCapability.wpDebugTelemetry:
                        patchedProperties[setting] = {
                            value: (this.opcDeviceSettings[setting] as any) = value || false,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    default:
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.updateDeviceProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }

        this.deferredStart.resolve();
    }

    private async updateDeviceProperties(properties: any): Promise<void> {
        if (!properties || !this.deviceTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.deviceTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve('');
                });
            });

            if (this.debugTelemetry()) {
                this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `Device live properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], `Error while updating client properties: ${ex.message}`);
        }
    }

    private async sendMessage(data: any): Promise<void> {
        if (!data || !this.deviceClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            await this.deviceClient.sendEvent(iotcMessage);

            if (this.debugTelemetry()) {
                this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], `sendMessage: ${ex.message}`);
            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], `inspect the error: ${JSON.stringify(ex, null, 4)}`);
        }
    }

    private async connectDeviceClientInternal(dpsHubConnectionString: string): Promise<IClientConnectResult> {
        const result: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        if (this.deviceClient) {
            if (this.deviceTwin) {
                this.deviceTwin.removeAllListeners();
            }

            if (this.deviceClient) {
                this.deviceTwin.removeAllListeners();

                await this.deviceClient.close();
            }

            this.deviceClient = null;
            this.deviceTwin = null;
        }

        try {
            this.deviceClient = await IoTDeviceClient.fromConnectionString(dpsHubConnectionString, IoTHubTransport);
            if (!this.deviceClient) {
                result.clientConnectionStatus = false;
                result.clientConnectionMessage = `Failed to connect device client interface from connection string - device: ${this.deviceProvisionInfo.deviceId}`;
            }
            else {
                result.clientConnectionStatus = true;
                result.clientConnectionMessage = `Successfully connected to IoT Central - device: ${this.deviceProvisionInfo.deviceId}`;
            }
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `Failed to instantiate client interface from configuration: ${ex.message}`;

            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], `${result.clientConnectionMessage}`);
        }

        if (result.clientConnectionStatus === false) {
            return result;
        }

        try {
            this.deviceClient.on('connect', this.onDeviceClientConnect);
            this.deviceClient.on('disconnect', this.onDeviceClientDisconnect);
            this.deviceClient.on('error', this.onDeviceClientError);

            await this.deviceClient.open();

            this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `Device (${this.deviceProvisionInfo.deviceId}) client is connected`);

            this.deviceTwin = await this.deviceClient.getTwin();
            this.deviceTwin.on('properties.desired', this.onHandleDeviceProperties);

            this.deviceClient.onDeviceMethod(OpcDeviceCapability.cmTurnOnIndicator, this.handleDirectMethod);
            this.deviceClient.onDeviceMethod(OpcDeviceCapability.cmTurnOffIndicator, this.handleDirectMethod);

            this.opcWriter = new OpcWriter(this.server, this.deviceProvisionInfo);

            result.clientConnectionStatus = true;
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `IoT Central connection error: ${ex.message}`;

            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], result.clientConnectionMessage);
        }

        return result;
    }

    @bind
    private onDeviceClientConnect() {
        this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `The device received a connect event`);
    }

    @bind
    private onDeviceClientDisconnect() {
        this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `The device received a disconnect event`);
    }

    @bind
    private onDeviceClientError(error: Error) {
        this.deviceClient = null;
        this.deviceTwin = null;

        this.server.log([this.deviceProvisionInfo.deviceId, 'error'], `Device client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    private async handleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `${commandRequest.methodName} command received`);

        let response: IModuleCommandResponse = {
            status: 200,
            message: ''
        };

        try {
            switch (commandRequest.methodName) {
                case OpcDeviceCapability.cmTurnOnIndicator:
                    response = await this.setIndicator(true);
                    break;

                case OpcDeviceCapability.cmTurnOffIndicator:
                    response = await this.setIndicator(false);
                    break;

                default:
                    response.status = 400;
                    response.message = `An unknown method name was found: ${commandRequest.methodName}`;
            }

            this.server.log([this.deviceProvisionInfo.deviceId, 'info'], response.message);
        }
        catch (ex) {
            response.status = 400;
            response.message = `An error occurred executing the command ${commandRequest.methodName}: ${ex.message}`;

            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], response.message);
        }

        await commandResponse.send(200, response);
    }

    private async setIndicator(indicatorSetting: boolean): Promise<IModuleCommandResponse> {
        this.server.log([this.deviceProvisionInfo.deviceId, 'info'], `setIndicator to value ${indicatorSetting ? 'true' : 'false'}`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: '',
            payload: {}
        };

        try {
            const writeOpcValueResult = await this.opcWriter.writeOpcValue(indicatorSetting);

            response.status = writeOpcValueResult.status;
            response.message = writeOpcValueResult.message;
        }
        catch (ex) {
            response.status = 400;
            response.message = `Failed to set indicator to value ${indicatorSetting ? 'true' : 'false'}: ${ex.message}`;

            this.server.log([this.deviceProvisionInfo.deviceId, 'error'], response.message);
        }

        return response;
    }
}
