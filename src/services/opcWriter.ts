import { Server } from '@hapi/hapi';
import {
    OPCUAClient,
    MessageSecurityMode,
    SecurityPolicy,
    AttributeIds,
    WriteValueOptions,
    ClientSession,
    ReadValueIdOptions
} from 'node-opcua';
import { IModuleCommandResponse } from 'src/plugins/iotCentralModule';
import { IDeviceProvisionInfo } from './miabGateway';

const ModuleName = 'OpcWriter';

export class OpcWriter {
    private server: Server;
    private deviceProvisionInfo: IDeviceProvisionInfo;

    constructor(server: Server, deviceProvisionInfo: IDeviceProvisionInfo) {
        this.server = server;
        this.deviceProvisionInfo = deviceProvisionInfo;
    }

    public async writeOpcValue(value: any): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `writeOpcValue`);

        const response: IModuleCommandResponse = {
            status: 200,
            message: 'Succeeded'
        };

        let client: OPCUAClient;
        let session: ClientSession;

        const connectionStrategy = {
            initialDelay: 1000,
            maxRetry: 1
        };

        try {
            client = OPCUAClient.create({
                applicationName: 'miabOpcClient',
                connectionStrategy,
                securityMode: MessageSecurityMode.None,
                securityPolicy: SecurityPolicy.None,
                endpointMustExist: false
            });

            this.server.log([ModuleName, 'info'], `OPC client created`);

            await client.connect(this.deviceProvisionInfo.opcPublisherNodesRequest.EndpointUrl);
            session = await client.createSession();

            this.server.log([ModuleName, 'info'], `OPC client session created`);

            const nodeToRead: ReadValueIdOptions = {
                nodeId: this.deviceProvisionInfo.opcPublisherNodesRequest.OpcNodes[0].Id,
                attributeId: AttributeIds.Value
            };

            const readOpcResult = await session.read(nodeToRead, 0);
            if (readOpcResult.statusCode.value !== 0) {
                response.status = 500;
                response.message = `Error while reading data type attribute of node id to write`;

                this.server.log([ModuleName, 'error'], response.message);
            }

            if (response.status === 200) {
                const nodeToWrite: WriteValueOptions = {
                    nodeId: this.deviceProvisionInfo.opcPublisherNodesRequest.OpcNodes[0].Id,
                    attributeId: AttributeIds.Value,
                    value: {
                        value: {
                            ...readOpcResult.value,
                            value
                        }
                    }
                };
                const writeStatus = await session.write(nodeToWrite);

                response.status = writeStatus.value === 0 ? 200 : 500;
                response.message = writeStatus.description;

                this.server.log([ModuleName, response.status === 200 ? 'info' : 'error'], response.message);
            }
        }
        catch (ex) {
            response.status = 500;
            response.message = `Error while attempting to write opc value: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        if (session) {
            await session.close();

            this.server.log([ModuleName, 'info'], `Closed OPC client session`);
        }

        if (client) {
            await client.disconnect();

            this.server.log([ModuleName, 'info'], `Closed OPC client`);
        }

        return response;
    }
}
