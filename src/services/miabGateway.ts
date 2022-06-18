import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import {
    OpcDevice
} from './opcDevice';
import { SymmetricKeySecurityClient } from 'azure-iot-security-symmetric-key';
import {
    RegistrationResult,
    ProvisioningDeviceClient
} from 'azure-iot-provisioning-device';
import { Mqtt as ProvisioningTransport } from 'azure-iot-provisioning-device-mqtt';
import {
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import {
    IIotCentralPluginModule,
    IModuleCommandResponse
} from '../plugins/iotCentralModule';
import { HealthState } from './health';
import * as Wreck from '@hapi/wreck';
import {
    OpcPublisherNodesRequest
} from '../types/miab';
import { bind, forget } from '../utils';

const ModuleName = 'MiabGatewayService';

const MiabInputPublisherRuntimeInfo = 'publisherruntimeinfo';
const MiabInputPublisherData = 'publisherdata';
const MiabInputModbus = 'modbus';

const DeviceCache = 'deviceCache';

enum DeviceCredentialType {
    None = 0,
    X509Certificate = 1,
    SymmetricKey = 2
}

interface IDeviceCredentials {
    idScope?: string;
    primaryKey?: string;
    secondaryKey?: string;
    type?: DeviceCredentialType;
    x509Certificate?: Uint8Array | string;
}

export interface IDeviceProvisionInfo {
    deviceId: string;
    modelId: string;
    deviceCredentials: IDeviceCredentials;
    opcPublisherNodesRequest: OpcPublisherNodesRequest;
}

interface IDeviceDeprovisionInfo {
    deviceId: string;
}

interface ITestOpcPublisherApiInfo {
    command: string;
    payload?: any;
}

enum DeviceCacheOperation {
    Update,
    Delete
}

interface IDeviceCacheInfo {
    deviceProvisionInfo: IDeviceProvisionInfo;
    dpsConnectionString: string;
}

interface IProvisionResult {
    dpsProvisionStatus: boolean;
    dpsProvisionMessage: string;
    dpsHubConnectionString: string;
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
    opcDevice: OpcDevice;
}

enum MiabGatewaySettings {
    wpDebugTelemetry = 'wpDebugTelemetry',
    wpDebugRoutedMessage = 'wpDebugRoutedMessage'
}

enum MiabGatewayCapability {
    evCreateOpcDevice = 'evCreateOpcDevice',
    evDeleteOpcDevice = 'evDeleteOpcDevice',
    cmProvisionOpcDevice = 'cmProvisionOpcDevice',
    cmDeprovisionOpcDevice = 'cmDeprovisionOpcDevice',
    cmTestOpcPublisherApi = 'cmTestOpcPublisherApi'
}

interface IMiabGatewaySettings {
    [MiabGatewaySettings.wpDebugTelemetry]: boolean;
    [MiabGatewaySettings.wpDebugRoutedMessage]: boolean;
}

@service('miabGateway')
export class MiabGatewayService {
    @inject('$server')
    private server: Server;

    private healthState = HealthState.Good;
    private iotCentralPluginModule: IIotCentralPluginModule;
    private moduleSettings: IMiabGatewaySettings = {
        [MiabGatewaySettings.wpDebugTelemetry]: true,
        [MiabGatewaySettings.wpDebugRoutedMessage]: true
    };
    private opcDeviceMap = new Map<string, OpcDevice>();

    public async init(): Promise<void> {
        this.server.log([ModuleName, 'info'], 'initialize');
    }

    public async initializeModule(): Promise<void> {
        this.server.log([ModuleName, 'info'], `initializeModule`);

        this.iotCentralPluginModule = this.server.settings.app.iotCentral;
    }

    public async onHandleModuleProperties(desiredChangedSettings: any): Promise<void> {
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
                    case MiabGatewaySettings.wpDebugTelemetry:
                    case MiabGatewaySettings.wpDebugRoutedMessage:
                        patchedProperties[setting] = {
                            value: this.moduleSettings[setting] = value || false,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    default:
                        this.server.log([ModuleName, 'error'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }
            }

            if (Object.prototype.hasOwnProperty.call(patchedProperties, 'value')) {
                await this.iotCentralPluginModule.updateModuleProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }
    }

    public onModuleClientError(error: Error): void {
        this.server.log([ModuleName, 'error'], `Module client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    public async onHandleDownstreamMessages(inputName: string, message: IoTMessage): Promise<void> {
        this.server.log([ModuleName, 'info'], `onHandleDownstreamMessages on input: ${inputName}`);

        try {
            const messageData = message.getBytes().toString('utf8');
            if (!messageData) {
                return;
            }

            const messageJson = JSON.parse(messageData);

            if (this.moduleSettings[MiabGatewaySettings.wpDebugRoutedMessage] === true) {
                if (message.properties?.propertyList) {
                    this.server.log([ModuleName, 'info'], `Routed message properties: ${JSON.stringify(message.properties?.propertyList, null, 4)}`);
                }

                this.server.log([ModuleName, 'info'], `Routed message data: ${JSON.stringify(messageJson, null, 4)}`);
            }

            switch (inputName) {
                case MiabInputPublisherData: {
                    const deviceId = messageJson.DataSetWriterGroup;
                    if (!deviceId) {
                        if (this.iotCentralPluginModule.debugTelemetry()) {
                            this.server.log([ModuleName, 'error'], `Received ${inputName} message but no deviceId was found in the subject property`);
                        }

                        break;
                    }

                    const opcDevice = this.opcDeviceMap.get(deviceId);
                    if (!opcDevice) {
                        this.server.log([ModuleName, 'error'], `Received Opc Publisher telemetry for deviceId: "${deviceId}" but that device does not exist in MiaB Gateway`);
                    }
                    else {
                        await opcDevice.processOpcData(messageJson);
                    }

                    break;
                }

                case MiabInputPublisherRuntimeInfo:
                    break;

                case MiabInputModbus:
                    break;

                default:
                    this.server.log([ModuleName, 'warning'], `Warning: received routed message for unknown input: ${inputName}`);
                    break;
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while handling downstream message: ${ex.message}`);
        }
    }

    public async onModuleReady(): Promise<void> {
        this.server.log([ModuleName, 'info'], `Starting onModuleReady initializaton`);

        this.healthState = this.iotCentralPluginModule.moduleClient ? HealthState.Good : HealthState.Critical;

        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmProvisionOpcDevice, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmDeprovisionOpcDevice, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmTestOpcPublisherApi, this.handleDirectMethod);

        await this.recreateCachedDevices();
    }

    public async onHealth(): Promise<HealthState> {
        for (const device of this.opcDeviceMap) {
            forget(device[1].getHealth);
        }

        return this.healthState;
    }

    public async iotcApiRequest(uri: string, method: string, options: any): Promise<any> {
        try {
            const iotcApiResponse = await Wreck[method](uri, options);

            if (iotcApiResponse.res.statusCode < 200 || iotcApiResponse.res.statusCode > 299) {
                this.server.log([ModuleName, 'error'], `Response status code = ${iotcApiResponse.res.statusCode}`);

                throw new Error((iotcApiResponse.payload as any)?.message || iotcApiResponse.payload || 'An error occurred');
            }

            return iotcApiResponse;
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `iotcApiRequest: ${ex.message}`);
            throw ex;
        }
    }

    @bind
    private async handleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([ModuleName, 'info'], `${commandRequest.methodName} command received`);

        let response: IModuleCommandResponse = {
            status: 200,
            message: ''
        };

        try {
            switch (commandRequest.methodName) {
                case MiabGatewayCapability.cmProvisionOpcDevice:
                    response = await this.provisionOpcDevice(commandRequest.payload);
                    break;

                case MiabGatewayCapability.cmDeprovisionOpcDevice:
                    response = await this.deprovisionOpcDevice(commandRequest.payload);
                    break;

                case MiabGatewayCapability.cmTestOpcPublisherApi:
                    response = await this.testOpcPublisherApi(commandRequest.payload);
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

    private async provisionOpcDevice(deviceProvisionInfo: IDeviceProvisionInfo): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `provisionOpcDevice - url: ${deviceProvisionInfo.opcPublisherNodesRequest.EndpointUrl}`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const provisionOpcDeviceResult = await this.createOpcDevice(deviceProvisionInfo);
            response.status = (provisionOpcDeviceResult.dpsProvisionStatus && provisionOpcDeviceResult.clientConnectionStatus) ? 200 : 400;
            response.message = provisionOpcDeviceResult.clientConnectionMessage || provisionOpcDeviceResult.dpsProvisionMessage;

            if (response.status === 200) {
                const publishNodesResponse = await this.iotCentralPluginModule.invokeDirectMethod(
                    this.server.settings.app.miabGateway.moduleEnvironmentConfig.opcPublisherModuleId, 'PublishNodes_V1', deviceProvisionInfo.opcPublisherNodesRequest, 10, 10);

                response.status = publishNodesResponse.status;

                if (response.status !== 200) {
                    response.message = publishNodesResponse?.payload?.error?.code || `An error occurred while attempting to publish the specified nodes`;
                    response.payload = publishNodesResponse?.payload?.error || {};

                    this.server.log([ModuleName, 'error'], response.message);
                }
                else {
                    response.message = `provisionOpcDevice succeeded for url: ${deviceProvisionInfo.opcPublisherNodesRequest.EndpointUrl}`;

                    this.server.log([ModuleName, 'info'], response.message);
                }
            }
        }
        catch (ex) {
            response.status = 500;
            response.message = `provisionOpcDevice failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async createOpcDevice(deviceProvisionInfo: IDeviceProvisionInfo, cachedDpsConnectionString?: string): Promise<IProvisionResult> {
        this.server.log([ModuleName, 'info'], `createOpcDevice`);

        let deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            opcDevice: null
        };

        try {
            this.server.log([ModuleName, 'info'], `createOpcDevice - assetId: ${deviceProvisionInfo.deviceId}`);

            deviceProvisionResult = await this.createAndProvisionOpcDevice(deviceProvisionInfo, cachedDpsConnectionString);

            if (deviceProvisionResult.dpsProvisionStatus && deviceProvisionResult.clientConnectionStatus) {
                this.opcDeviceMap.set(deviceProvisionInfo.deviceId, deviceProvisionResult.opcDevice);

                await this.iotCentralPluginModule.sendMessage({
                    [MiabGatewayCapability.evCreateOpcDevice]: deviceProvisionInfo.deviceId
                });

                this.server.log([ModuleName, 'info'], `Succesfully provisioned opc device with id: ${deviceProvisionInfo.deviceId}`);

                await this.updateCachedDeviceInfo(
                    DeviceCacheOperation.Update,
                    deviceProvisionInfo.deviceId,
                    {
                        deviceProvisionInfo,
                        dpsConnectionString: deviceProvisionResult.dpsHubConnectionString
                    }
                );
            }
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning opcDevice: ${ex.message}`;

            this.server.log([ModuleName, 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async createAndProvisionOpcDevice(deviceProvisionInfo: IDeviceProvisionInfo, cachedDpsConnectionString?: string): Promise<IProvisionResult> {
        this.server.log([ModuleName, 'info'], `Provisioning deviceId: ${deviceProvisionInfo.deviceId}`);

        const deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            opcDevice: null
        };

        try {
            let dpsConnectionString = cachedDpsConnectionString;

            if (!dpsConnectionString) {
                const provisioningSecurityClient = new SymmetricKeySecurityClient(deviceProvisionInfo.deviceId, deviceProvisionInfo.deviceCredentials.primaryKey);
                const provisioningClient = ProvisioningDeviceClient.create(
                    this.server.settings.app.miabGateway.moduleEnvironmentConfig.dpsProvisioningHost,
                    deviceProvisionInfo.deviceCredentials.idScope,
                    new ProvisioningTransport(),
                    provisioningSecurityClient);

                const provisioningPayload = {
                    iotcModelId: deviceProvisionInfo.modelId,
                    iotcGateway: {
                        iotcGatewayId: this.iotCentralPluginModule.deviceId,
                        iotcModuleId: this.iotCentralPluginModule.moduleId
                    }
                };

                provisioningClient.setProvisioningPayload(provisioningPayload);
                this.server.log([ModuleName, 'info'], `setProvisioningPayload succeeded ${JSON.stringify(provisioningPayload, null, 4)}`);

                const dpsResult = await provisioningClient.register();

                // eslint-disable-next-line max-len
                dpsConnectionString = `HostName=${(dpsResult as RegistrationResult).assignedHub};DeviceId=${(dpsResult as RegistrationResult).deviceId};SharedAccessKey=${deviceProvisionInfo.deviceCredentials.primaryKey}`;

                this.server.log([ModuleName, 'info'], `register device client succeeded`);
            }

            deviceProvisionResult.dpsProvisionStatus = true;
            deviceProvisionResult.dpsProvisionMessage = `IoT Central successfully provisioned device: ${deviceProvisionInfo.deviceId}`;
            deviceProvisionResult.dpsHubConnectionString = dpsConnectionString;

            deviceProvisionResult.opcDevice = new OpcDevice(this.server, deviceProvisionInfo);

            const { clientConnectionStatus, clientConnectionMessage } = await deviceProvisionResult.opcDevice.connectDeviceClient(dpsConnectionString);

            this.server.log([ModuleName, 'info'], `clientConnectionStatus: ${clientConnectionStatus}, clientConnectionMessage: ${clientConnectionMessage}`);

            deviceProvisionResult.clientConnectionStatus = clientConnectionStatus;
            deviceProvisionResult.clientConnectionMessage = clientConnectionMessage;
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.server.log([ModuleName, 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async deprovisionOpcDevice(deviceDeprovisionInfo: IDeviceDeprovisionInfo): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `Deprovisioning device - id: ${deviceDeprovisionInfo.deviceId}`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: `Finished deprovisioning opc device ${deviceDeprovisionInfo.deviceId}`,
            payload: {}
        };

        try {
            const opcDevice = this.opcDeviceMap.get(deviceDeprovisionInfo.deviceId);
            if (opcDevice) {
                await opcDevice.disconnect();

                // const reprovisionOpcDeviceResult = await this.reprovisionOpcPublishedNodes();
                const reprovisionOpcDeviceResult = await this.iotCentralPluginModule.invokeDirectMethod(
                    this.server.settings.app.miabGateway.moduleEnvironmentConfig.opcPublisherModuleId, 'UnpublishNodes_V1', opcDevice.deviceProvisionInfo.opcPublisherNodesRequest, 10, 10);

                response.status = reprovisionOpcDeviceResult.status;

                if (response.status !== 200) {
                    response.message = reprovisionOpcDeviceResult?.payload?.error?.code || `An error occurred while attempting to deprovision deviceId: ${deviceDeprovisionInfo.deviceId}`;
                    response.payload = reprovisionOpcDeviceResult?.payload?.error || {};

                    this.server.log([ModuleName, 'error'], response.message);
                }
                else {
                    response.message = `deprovisionOpcDevice succeeded`;

                    this.server.log([ModuleName, 'info'], response.message);
                }

                this.opcDeviceMap.delete(deviceDeprovisionInfo.deviceId);
            }

            await this.updateCachedDeviceInfo(DeviceCacheOperation.Delete, deviceDeprovisionInfo.deviceId);

            // this.server.log([ModuleName, 'info'], `Deleting IoT Central device instance: ${deviceDeprovisionInfo.deviceId}`);
            // try {
            //     const gatewayConfiguration = await this.server.settings.app.config.get(GatewayConfiguration) as IConfigureGatewayInfo;

            //     await this.iotcApiRequest(
            //         `https://${gatewayConfiguration.appHostUri}/api/preview/devices/${deviceDeprovisionInfo.deviceId}`,
            //         'delete',
            //         {
            //             headers: {
            //                 Authorization: gatewayConfiguration.apiAccessKey
            //             },
            //             json: true
            //         });

            //     await this.iotCentralPluginModule.sendMessage({
            //         [MiabGatewayCapability.evDeleteOpcDevice]: deviceDeprovisionInfo.deviceId
            //     });

            //     this.server.log([ModuleName, 'info'], `Succesfully deprovisioned opc device with id: ${deviceDeprovisionInfo.deviceId}`);
            // }
            // catch (ex) {
            //     response.status = 400;
            //     response.message = `Request to delete the IoT Central device failed: ${ex.message}`;

            //     this.server.log([ModuleName, 'error'], response.message);
            // }
        }
        catch (ex) {
            response.status = 400;
            response.message = `Failed to deprovision device: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async testOpcPublisherApi(request: ITestOpcPublisherApiInfo): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `testOpcPublisherApi`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: '',
            payload: {}
        };

        try {
            const testOpcPublisherResult = await this.iotCentralPluginModule.invokeDirectMethod(
                this.server.settings.app.miabGateway.moduleEnvironmentConfig.opcPublisherModuleId, request.command, request.payload, 10, 10);

            response.status = testOpcPublisherResult.status;

            if (response.status !== 200) {
                response.message = testOpcPublisherResult?.payload?.error?.code || `An error occurred while attempting to attempting to execute OPC Publisher API: ${request.command}`;
                response.payload = testOpcPublisherResult?.payload?.error || {};

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                response.message = `testOpcPublisherApi succeeded`;

                this.server.log([ModuleName, 'info'], response.message);
            }
        }
        catch (ex) {
            response.status = 400;
            response.message = `Failed to execute api test: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    // @ts-ignore
    private async reprovisionOpcPublishedNodes(): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `reprovisionOpcPublishedNodes`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: `Finished reprovisioning opc nodes`,
            payload: {}
        };

        try {
            const opcPublisherNodesRequest = [...this.opcDeviceMap].map((mapItem: [string, OpcDevice]) => {
                const deviceProvisionInfo = mapItem[1].deviceProvisionInfo;
                return {
                    ...deviceProvisionInfo.opcPublisherNodesRequest
                };
            });

            const reprovisionNodesResult = await this.iotCentralPluginModule.invokeDirectMethod(
                this.server.settings.app.miabGateway.moduleEnvironmentConfig.opcPublisherModuleId, 'AddOrUpdateEndpoints_V1', opcPublisherNodesRequest, 10, 10);

            response.status = reprovisionNodesResult.status;

            if (response.status !== 200) {
                response.message = reprovisionNodesResult?.payload?.error?.code || `An error occurred while attempting to reprovision opc nodes`;
                response.payload = reprovisionNodesResult?.payload?.error || {};

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                response.message = `reprovisionOpcPublishedNodes succeeded`;

                this.server.log([ModuleName, 'info'], response.message);
            }
        }
        catch (ex) {
            response.status = 400;
            response.message = `Failed to reprovision device: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async getCachedDeviceList(): Promise<IDeviceCacheInfo[]> {
        const deviceCache = await this.server.settings.app.config.get(DeviceCache);

        return deviceCache?.cache || [];
    }

    private async updateCachedDeviceInfo(operation: DeviceCacheOperation, deviceId: string, cacheProvisionInfo?: IDeviceCacheInfo): Promise<void> {
        try {
            const deviceCache = await this.server.settings.app.config.get(DeviceCache);
            const cachedDeviceList: IDeviceCacheInfo[] = deviceCache?.cache || [];
            const cachedDeviceIndex = cachedDeviceList.findIndex((element) => element.deviceProvisionInfo.deviceId === deviceId);

            switch (operation) {
                case DeviceCacheOperation.Update:
                    if (cachedDeviceIndex === -1) {
                        cachedDeviceList.push(cacheProvisionInfo);
                    }
                    else {
                        cachedDeviceList[cachedDeviceIndex] = {
                            ...cachedDeviceList[cachedDeviceIndex],
                            ...cacheProvisionInfo
                        };
                    }
                    break;

                case DeviceCacheOperation.Delete:
                    if (cachedDeviceIndex > -1) {
                        cachedDeviceList.splice(cachedDeviceIndex, 1);
                    }
                    break;
            }

            await this.server.settings.app.config.set(DeviceCache, {
                cache: cachedDeviceList
            });
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while updating cached device info (udpate): ${ex.message}`);
        }
    }

    private async recreateCachedDevices() {
        this.server.log([ModuleName, 'info'], 'Recreate devices using cached device information');

        try {
            const cachedDeviceList = await this.getCachedDeviceList();

            this.server.log([ModuleName, 'info'], `Found ${cachedDeviceList.length} cached devices`);
            if (this.iotCentralPluginModule.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `${JSON.stringify(cachedDeviceList, null, 4)}`);
            }

            for (const cachedDevice of cachedDeviceList) {
                let retryProvisioning = false;

                try {
                    const provisionResult = await this.createOpcDevice(cachedDevice.deviceProvisionInfo, cachedDevice.dpsConnectionString);
                    if (!provisionResult.dpsProvisionStatus || !provisionResult.clientConnectionStatus) {
                        this.server.log([ModuleName, 'warning'], `An error occurred (using cached device info): ${provisionResult.dpsProvisionMessage || provisionResult.clientConnectionMessage}`);

                        retryProvisioning = true;
                    }
                }
                catch (ex) {
                    this.server.log([ModuleName, 'error'], `An error occurred while re-creating the device: ${cachedDevice.deviceProvisionInfo.deviceId} - ${ex.message}`);
                    retryProvisioning = true;
                }

                if (retryProvisioning) {
                    try {
                        const provisionResult = await this.createOpcDevice(cachedDevice.deviceProvisionInfo);
                        if (!provisionResult.dpsProvisionStatus || !provisionResult.clientConnectionStatus) {
                            this.server.log([ModuleName, 'warning'], `An error occurred (using dps provisioning): ${provisionResult.dpsProvisionMessage || provisionResult.clientConnectionMessage}`);
                        }
                    }
                    catch (ex) {
                        this.server.log([ModuleName, 'error'], `An error occurred while re-creating the device: ${cachedDevice.deviceProvisionInfo.deviceId} - ${ex.message}`);
                        retryProvisioning = true;
                    }
                }
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Failed to get device list: ${ex.message}`);
        }

        // If there were errors, we may be in a bad state (e.g. an opc device exists but we
        // were not able to re-connect to it's client interface). Consider setting the health
        // state to critical here to restart the gateway module.
    }
}
