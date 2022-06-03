import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { IIotCentralPluginModule } from '../plugins/iotCentralModule';
import { bind } from '../utils';

export const healthCheckInterval = 15;
// const healthCheckTimeout = 30;
// const healthCheckStartPeriod = 60;
// const healthCheckRetries = 3;

export enum HealthState {
    Good = 2,
    Warning = 1,
    Critical = 0
}

@service('health')
export class HealthService {
    @inject('$server')
    private server: Server;

    private iotCentralPluginModule: IIotCentralPluginModule;

    // private heathCheckStartTime = Date.now();
    // private failingStreak = 1;

    public async init(): Promise<void> {
        this.server.log(['HealthService', 'info'], 'initialize');

        this.iotCentralPluginModule = this.server.settings.app.iotCentral;
    }

    @bind
    public async checkHealthState(): Promise<number> {
        const moduleHealth = await this.iotCentralPluginModule.getHealth();

        this.server.log(['HealthService', 'info'], `Health check state: ${HealthState[moduleHealth]}`);

        return moduleHealth;
    }
}
