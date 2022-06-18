import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import {
    IIotCentralPluginModuleOptions,
    iotCentralPluginModule
} from './iotCentralModule';
import {
    MiabGatewayService
} from '../services/miabGateway';

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        miabGateway?: IMiabGatewayPluginModule;
    }
}

const ModuleName = 'MiabGatewayPluginModule';

export interface IModuleEnvironmentConfig {
    opcPublisherModuleId: string;
    dpsProvisioningHost: string;
}

export interface IMiabGatewayPluginModule {
    moduleEnvironmentConfig: IModuleEnvironmentConfig;
}

export class MiabGatewayPlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    @inject('miabGateway')
    private miabGateway: MiabGatewayService;

    public async init(): Promise<void> {
        this.server.log([ModuleName, 'info'], `init`);
    }

    public async register(server: Server, _options: any): Promise<void> {
        server.log([ModuleName, 'info'], 'register');

        try {
            server.settings.app.miabGateway = new MiabGatewayPluginModule(server);

            const pluginOptions: IIotCentralPluginModuleOptions = {
                initializeModule: this.miabGateway.initializeModule.bind(this.miabGateway),
                onHandleModuleProperties: this.miabGateway.onHandleModuleProperties.bind(this.miabGateway),
                onModuleClientError: this.miabGateway.onModuleClientError.bind(this.miabGateway),
                onHandleDownstreamMessages: this.miabGateway.onHandleDownstreamMessages.bind(this.miabGateway),
                onModuleReady: this.miabGateway.onModuleReady.bind(this.miabGateway),
                onHealth: this.miabGateway.onHealth.bind(this.miabGateway)
            };

            await server.register([
                {
                    plugin: iotCentralPluginModule,
                    options: pluginOptions
                }
            ]);
        }
        catch (ex) {
            server.log([ModuleName, 'error'], `Error while registering : ${ex.message}`);
        }
    }
}

class MiabGatewayPluginModule implements IMiabGatewayPluginModule {
    // @ts-ignore
    private server: Server;

    constructor(server: Server) {
        this.server = server;
    }

    public moduleEnvironmentConfig: IModuleEnvironmentConfig = {
        opcPublisherModuleId: process.env.opcPublisherModuleId || 'opcpublisher',
        dpsProvisioningHost: process.env.dpsProvisioningHost || 'global.azure-devices-provisioning.net'
    };
}
