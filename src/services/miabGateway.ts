import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import {
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import {
    IotcOutputName,
    IIotCentralPluginModule,
    IModuleCommandResponse
} from '../plugins/iotCentralModule';
import { HealthState } from './health';
import { resolve as resolvePath } from 'path';
import {
    gzipSync,
    gunzipSync
} from 'zlib';
import * as Wreck from '@hapi/wreck';
import { v4 as uuidv4 } from 'uuid';
import { bind, sleep, writeFileStream } from '../utils';
import { Models as ICModels } from '../types/miab';
import moment = require('moment');

const ModuleName = 'MiabGatewayService';

interface IModuleEnvironmentConfig {
    opcPublisherAdapterModuleId: string;
    dpsProvisioningHost: string;
}

export enum MiabGatewayCapability {
    evFetchedOpcNodesAutoDiscovery = 'evFetchedOpcNodesAutoDiscovery',
    evFetchedOpcNodesStarted = 'evFetchedOpcNodesStarted',
    evFetchedOpcNodesFinished = 'evFetchedOpcNodesFinished',
    evFetchedOpcNodesError = 'evFetchedOpcNodesError',
    wpOpcEndpoint = 'wpOpcEndpoint',
    wpServerNodeDiscoveryRoot = 'wpServerNodeDiscoveryRoot',
    cmStartOpcNodeDiscovery = 'cmStartOpcNodeDiscovery',
    cmTestConnection = 'cmTestConnection',
    cmFetchNodes = 'cmFetchNodes',
    cmWriteValues = 'cmWriteValues',
    cmReadValues = 'cmReadValues',
    cmAddOrUpdateAssets = 'cmAddOrUpdateAssets',
    cmGetAllAssets = 'cmGetAllAssets',
    cmRemoveAssets = 'cmRemoveAssets',
}

interface IMiabGatewaySettings {
    [MiabGatewayCapability.wpOpcEndpoint]: ICModels.Endpoint;
    [MiabGatewayCapability.wpServerNodeDiscoveryRoot]: string;
}

export interface IMiabGatewayUtility {
    moduleEnvironmentConfig: IModuleEnvironmentConfig;
    getModuleSetting(setting: string): any;
    iotcApiRequest(uri: string, method: string, options: any): Promise<any>;
}

@service('miabGateway')
export class MiabGatewayService implements IMiabGatewayUtility {
    @inject('$server')
    private server: Server;

    private healthState = HealthState.Good;
    private iotCentralPluginModule: IIotCentralPluginModule;
    private moduleSettings: IMiabGatewaySettings = {
        [MiabGatewayCapability.wpOpcEndpoint]: {
            uri: '',
            securityMode: 0,
            credentials: {
                credentialType: 0,
                username: '',
                password: ''
            }
        },
        [MiabGatewayCapability.wpServerNodeDiscoveryRoot]: ''
    };
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
                    case MiabGatewayCapability.wpOpcEndpoint:
                        patchedProperties[setting] = {
                            value: this.moduleSettings[setting] = value || {
                                uri: '',
                                securityMode: 0,
                                credentials: {
                                    credentialType: 0,
                                    username: '',
                                    password: ''
                                }
                            },
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    case MiabGatewayCapability.wpServerNodeDiscoveryRoot:
                        patchedProperties[setting] = {
                            value: this.moduleSettings[setting] = value || '',
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

    public async onModuleReady(): Promise<void> {
        this.server.log([ModuleName, 'info'], `Starting onModuleReady initializaton`);

        this.healthState = this.iotCentralPluginModule.moduleClient ? HealthState.Good : HealthState.Critical;

        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmStartOpcNodeDiscovery, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmTestConnection, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmFetchNodes, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmWriteValues, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmReadValues, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmAddOrUpdateAssets, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmGetAllAssets, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmRemoveAssets, this.handleDirectMethod);

        // check for endpoint and node settings and kick off a scan for nodes
        void this.startOpcNodeDiscovery();
    }

    @bind
    public async onHealth(): Promise<HealthState> {
        return this.healthState;
    }

    public moduleEnvironmentConfig: IModuleEnvironmentConfig = {
        opcPublisherAdapterModuleId: process.env.opcPublisherAdapterModuleId || 'opcpublisher',
        dpsProvisioningHost: process.env.dpsProvisioningHost || 'global.azure-devices-provisioning.net'
    };

    public getModuleSetting(setting: string): any {
        return this.moduleSettings[setting];
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

    private async startOpcNodeDiscovery(): Promise<IModuleCommandResponse> {
        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        const discoveryRoot = this.moduleSettings[MiabGatewayCapability.wpServerNodeDiscoveryRoot];

        try {
            if (!discoveryRoot || !this.moduleSettings[MiabGatewayCapability.wpOpcEndpoint].uri) {
                response.message = `Some of the required settings for fetchNodes are missing`;

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                await this.iotCentralPluginModule.sendMeasurement({
                    [MiabGatewayCapability.evFetchedOpcNodesAutoDiscovery]: `Starting auto-discovery at node: ${discoveryRoot}`
                }, IotcOutputName);


                const fetchNodesResult = await this.fetchNodes({
                    opcEndpoint: this.moduleSettings[MiabGatewayCapability.wpOpcEndpoint],
                    startNode: discoveryRoot,
                    depth: 5,
                    requestedNodeClasses: [1, 2],
                    requestedAttributes: [2, 3, 4, 5, 14]
                });

                response.status = fetchNodesResult.status;

                if (response.status !== 200) {
                    response.message = fetchNodesResult.message || `An error occurred while testing the opcua url`;
                    response.payload = fetchNodesResult.payload || {};

                    this.server.log([ModuleName, 'error'], response.message);
                }
                else {
                    response.message = `fetchNodes succeeded for root node: ${discoveryRoot}`;

                    this.server.log([ModuleName, 'info'], response.message);
                }
            }
        }
        catch (ex) {
            response.status = 500;
            response.message = `testConnection failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async testConnection(testConnectionRequest: ICModels.TestConnectionRequest): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `testConnection - url: ${testConnectionRequest.opcEndpoint.uri}`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const testConnectionResult = await this.iotCentralPluginModule.invokeDirectMethod(this.moduleEnvironmentConfig.opcPublisherAdapterModuleId, 'TestConnection_v1', testConnectionRequest, 10, 10);

            response.status = testConnectionResult.status;

            if (response.status !== 200) {
                response.message = testConnectionResult?.payload?.error?.code || `An error occurred while testing the opcua url`;
                response.payload = testConnectionResult?.payload?.error || {};

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                response.message = `testConnection succeeded for url: ${testConnectionRequest.opcEndpoint.uri}`;

                this.server.log([ModuleName, 'info'], response.message);
            }
        }
        catch (ex) {
            response.status = 500;
            response.message = `testConnection failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async fetchNodes(browseNodesRequest: ICModels.BrowseNodesRequest): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `fetchNodes`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        const fetchJobId = uuidv4();

        try {
            this.server.log([ModuleName, 'info'], `Starting node: ${browseNodesRequest.startNode}, depth: ${browseNodesRequest.depth}`);

            await this.iotCentralPluginModule.sendMeasurement({
                [MiabGatewayCapability.evFetchedOpcNodesStarted]: `Starting node: ${browseNodesRequest.startNode}, depth: ${browseNodesRequest.depth}, jobId: ${fetchJobId}`
            }, IotcOutputName);

            this.server.log([ModuleName, 'info'], `Calling BrowseNodes_v1`);

            const browseNodesResult = await this.iotCentralPluginModule.invokeDirectMethod(this.moduleEnvironmentConfig.opcPublisherAdapterModuleId, 'BrowseNodes_v1', browseNodesRequest);

            response.status = browseNodesResult.status;

            this.server.log([ModuleName, 'info'], `BrowseNodes_v1 returned status: ${browseNodesResult.status}`);

            if (browseNodesResult.status !== 200 || !browseNodesResult.payload?.JobId) {
                response.message = browseNodesResult?.payload?.error?.code || `Unknown error in the response from fetchNodes - status: ${browseNodesResult.status}`;
                response.payload = browseNodesResult?.payload?.error;

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                const blobFilename = `fetchNodes-${moment.utc().format('YYYYMMDD-HHmmss')}.json`;
                const fetchedNodesFilePath = resolvePath(this.server.settings.app.storageRootDirectory, blobFilename);

                let fetchBrowsedNodesResult;

                const fetchedNodesFileWriteStream = writeFileStream(fetchedNodesFilePath);
                fetchedNodesFileWriteStream.create();
                await fetchedNodesFileWriteStream.write('[');

                try {
                    do {
                        const continuationToken = fetchBrowsedNodesResult?.payload?.continuationToken || '1';

                        this.server.log([ModuleName, 'info'], `Calling fetchBrowsedNodes with JobId: ${browseNodesResult.payload.JobId} and ContinuationToken: ${continuationToken}`);

                        fetchBrowsedNodesResult = await this.fetchBrowsedNodes(browseNodesResult.payload.JobId, continuationToken);

                        this.server.log([ModuleName, 'info'], `fetchBrowsedNodes returned status: ${fetchBrowsedNodesResult.status}`);

                        if (fetchBrowsedNodesResult.status === 200 && fetchBrowsedNodesResult?.payload?.nodes) {
                            this.server.log([ModuleName, 'info'], `fetchBrowsedNodes returned ${fetchBrowsedNodesResult.payload.nodes.length} nodes`);

                            let iNode = 0;
                            for (const node of fetchBrowsedNodesResult.payload.nodes) {
                                await fetchedNodesFileWriteStream.writeJson(node);

                                if (++iNode < fetchBrowsedNodesResult.payload.nodes.length) {
                                    await fetchedNodesFileWriteStream.write(',');
                                }
                            }
                        }

                        response.status = fetchBrowsedNodesResult.status;
                    } while (fetchBrowsedNodesResult.status === 200 && fetchBrowsedNodesResult?.payload?.continuationToken);
                }
                catch (ex) {
                    response.status = fetchBrowsedNodesResult.status || 500;
                    response.message = `Error while fetching node chunks: ${ex.message}`;

                    this.server.log([ModuleName, 'error'], response.message);
                }
                finally {
                    await fetchedNodesFileWriteStream.write(']');
                    await fetchedNodesFileWriteStream.close();
                }

                if (fetchBrowsedNodesResult.status === 200) {
                    // await this.uploadFetchedNodesFile(fetchedNodesFilePath, blobFilename, 'application/json');

                    // don't wait for this
                    void this.iotCentralPluginModule.sendLargePayload(fetchedNodesFilePath);
                }

                response.status = fetchBrowsedNodesResult.status;
                response.message = fetchBrowsedNodesResult.message;
                response.payload = fetchBrowsedNodesResult.payload;
            }
        }
        catch (ex) {
            response.status = 500;
            response.message = `fetchNodes failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        if (response.status === 200) {
            await this.iotCentralPluginModule.sendMeasurement({
                [MiabGatewayCapability.evFetchedOpcNodesFinished]: `Status: ${response.status}, jobId: ${fetchJobId}`
            }, IotcOutputName);
        }
        else {
            await this.iotCentralPluginModule.sendMeasurement({
                [MiabGatewayCapability.evFetchedOpcNodesError]: `Status: ${response.status}, jobId: ${fetchJobId}, Message: ${response.message},`
            }, IotcOutputName);
        }

        return response;
    }

    private async fetchBrowsedNodes(jobId: string, continuationToken: string): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `fetchBrowsedNodes`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const fetchBrowsedNodesResult = await this.chunkRequest('FetchBrowsedNodes_v1', {
                JobId: jobId,
                ContinuationToken: continuationToken
            });

            Object.assign(response, fetchBrowsedNodesResult);
        }
        catch (ex) {
            response.status = 500;
            response.message = `fetchBrowsedNodes failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    // @ts-ignore
    private async uploadFetchedNodesFile(fetchedNodesFilePath: string, blobFilename: string, contentType: string): Promise<boolean> {
        this.server.log([ModuleName, 'info'], `uploadFetchedNodesFile`);

        let result = true;

        try {
            const blobUrl = await this.server.settings.app.blobStorage.putFileIntoBlobStorage(fetchedNodesFilePath, blobFilename, contentType);

            await this.iotCentralPluginModule.sendMeasurement({
                [MiabGatewayCapability.evFetchedOpcNodesUploaded]: blobUrl
            }, IotcOutputName);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error uploading file to blob storage: ${ex.message}`);

            result = false;
        }

        return result;
    }

    private async writeValues(writeNodesRequests: ICModels.WriteValuesRequest[]): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `writeValues`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const writeValuesResult = await this.chunkRequest('WriteValues_v1', writeNodesRequests);

            Object.assign(response, writeValuesResult);
        }
        catch (ex) {
            response.status = 500;
            response.message = `writeValues failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async readValues(readNodesRequests: ICModels.ReadValuesRequest[]): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `readValues`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const readValuesResult = await this.chunkRequest('ReadValues_v1', readNodesRequests);

            Object.assign(response, readValuesResult);
        }
        catch (ex) {
            response.status = 500;
            response.message = `readValues failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async addOrUpdateAssets(addOrUpdateAssetsRequests: ICModels.AddOrUpdateAssetRequest[]): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `addOrUpdateAssets`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const readValuesResult = await this.chunkRequest('AddOrUpdateAssets_v1', addOrUpdateAssetsRequests);

            Object.assign(response, readValuesResult);
        }
        catch (ex) {
            response.status = 500;
            response.message = `addOrUpdateAssets failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async getAllAssets(): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `getAllAssets`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const getAllAssetsResult = await this.chunkRequest('GetAllAssets_v1', []);

            Object.assign(response, getAllAssetsResult);
        }
        catch (ex) {
            response.status = 500;
            response.message = `getAllAssets failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }


        return response;
    }

    private async removeAssets(assetIds: ICModels.RemoveAssetRequest[]): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `removeAssets`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const removeAssetsResult = await this.chunkRequest('RemoveAssets_v1', assetIds);

            Object.assign(response, removeAssetsResult);
        }
        catch (ex) {
            response.status = 500;
            response.message = `removeAssets failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async chunkRequest(methodName: string, methodRequest: any): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `chunkRequest`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const compressedRequest = gzipSync(JSON.stringify(methodRequest));

            let chunkResult = await this.iotCentralPluginModule.invokeDirectMethod(
                this.moduleEnvironmentConfig.opcPublisherAdapterModuleId,
                methodName,
                {
                    ContentLength: compressedRequest.length,
                    Payload: compressedRequest.toString('base64')
                }
            );

            response.status = chunkResult.status;

            if (chunkResult.status !== 202 || !chunkResult.payload?.RequestId) {
                response.message = chunkResult?.payload?.error?.code || `Unknown error in the chunked response from ${methodName} - status: ${chunkResult.status}`;
                response.payload = chunkResult?.payload?.error;

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                do {
                    await sleep(1000);

                    chunkResult = await this.iotCentralPluginModule.invokeDirectMethod(
                        this.moduleEnvironmentConfig.opcPublisherAdapterModuleId,
                        methodName,
                        {
                            RequestId: chunkResult.payload.RequestId
                        }
                    );

                    this.server.log([ModuleName, 'info'], `${methodName} returned status: ${chunkResult.status}`);
                } while (chunkResult.status === 102);

                if (chunkResult.status === 200
                    && chunkResult.payload.Status === 200
                    && chunkResult.payload?.Payload?.length) {
                    response.message = `${methodName} succeeded`;
                    response.payload = {
                        compressedPayload: chunkResult.payload.Payload,
                        ...JSON.parse(gunzipSync(Buffer.from(chunkResult.payload.Payload, 'base64')).toString())
                    };
                }
                else {
                    response.message = chunkResult?.payload?.error?.code || `Unknown error in the chunked response from ${methodName} - status: ${chunkResult.status}`;
                    response.payload = chunkResult?.payload?.error;

                    this.server.log([ModuleName, 'error'], response.message);
                }

                response.status = chunkResult.status;
            }
        }
        catch (ex) {
            response.status = 500;
            response.message = `${methodName} failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
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
                case MiabGatewayCapability.cmStartOpcNodeDiscovery:
                    response = await this.startOpcNodeDiscovery();
                    break;

                case MiabGatewayCapability.cmTestConnection:
                    response = await this.testConnection(commandRequest.payload);
                    break;

                case MiabGatewayCapability.cmFetchNodes:
                    response = await this.fetchNodes(commandRequest.payload);
                    break;

                case MiabGatewayCapability.cmWriteValues:
                    response = await this.writeValues(commandRequest.payload);
                    break;

                case MiabGatewayCapability.cmReadValues:
                    response = await this.readValues(commandRequest.payload);
                    break;

                case MiabGatewayCapability.cmAddOrUpdateAssets:
                    response = await this.addOrUpdateAssets(commandRequest.payload);
                    break;

                case MiabGatewayCapability.cmGetAllAssets:
                    response = await this.getAllAssets();
                    break;

                case MiabGatewayCapability.cmRemoveAssets:
                    response = await this.removeAssets(commandRequest.payload);
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
}
