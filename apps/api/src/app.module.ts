import { DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import type { AuthModuleOptions } from './modules/auth/contracts.js';
import { RunsModule } from './modules/runs/runs.module.js';
import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import type { WorkflowApiOptions } from './modules/runs/contracts.js';
import { DiagnosticsModule } from './modules/diagnostics/diagnostics.module.js';
import type { DiagnosticsModuleOptions } from './modules/diagnostics/contracts.js';
import { DealsModule } from './modules/deals/deals.module.js';
import type { DealsModuleOptions } from './modules/deals/contracts.js';
import { ExportsModule } from './modules/exports/exports.module.js';
import type { BriefExportService } from './modules/exports/exports.service.js';

@Module({})
export class AppModule {
  public static register(
    auth: AuthModuleOptions,
    workflow?: WorkflowApiOptions,
    diagnostics?: DiagnosticsModuleOptions,
    deals?: DealsModuleOptions,
    exports?: BriefExportService
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule,
        AuthModule.register(auth),
        ...(diagnostics === undefined ? [] : [DiagnosticsModule.register(diagnostics)]),
        ...(workflow === undefined ? [] : [RunsModule.register(workflow), ApprovalsModule.register(workflow.decideApproval, workflow.queries)]),
        ...(deals === undefined ? [] : [DealsModule.register(deals)]),
        ...(exports === undefined ? [] : [ExportsModule.register(exports)])
      ]
    };
  }
}
