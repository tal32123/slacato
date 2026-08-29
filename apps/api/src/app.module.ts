import { DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import type { AuthModuleOptions } from './modules/auth/contracts.js';
import { RunsModule } from './modules/runs/runs.module.js';
import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import type { WorkflowApiOptions } from './modules/runs/contracts.js';

@Module({})
export class AppModule {
  public static register(auth: AuthModuleOptions, workflow?: WorkflowApiOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule,
        AuthModule.register(auth),
        ...(workflow === undefined ? [] : [RunsModule.register(workflow), ApprovalsModule.register(workflow.decideApproval)])
      ]
    };
  }
}
