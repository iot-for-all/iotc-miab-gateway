import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import {
    IIotCentralPluginModuleOptions,
    iotCentralPluginModule
} from './iotCentralModule';
import {
    MiabGatewayService
} from '../services/miabGateway';

const ModuleName = 'MiabGatewayPluginModule';

export class MiabGatewayPlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    @inject('miabGateway')
    private miabGateway: MiabGatewayService;

    public async init(): Promise<void> {
        this.server.log([ModuleName, 'info'], `init`);
    }

    // @ts-ignore (options)
    public async register(server: Server, options: any): Promise<void> {
        server.log([ModuleName, 'info'], 'register');

        try {
            const pluginOptions: IIotCentralPluginModuleOptions = {
                initializeModule: this.miabGateway.initializeModule.bind(this.miabGateway),
                onHandleModuleProperties: this.miabGateway.onHandleModuleProperties.bind(this.miabGateway),
                onModuleClientError: this.miabGateway.onModuleClientError.bind(this.miabGateway),
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
