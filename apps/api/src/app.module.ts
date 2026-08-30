import { type DynamicModule, Module } from '@nestjs/common';
import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import type { AuthModuleOptions } from './modules/auth/contracts.js';
import type { DealsModuleOptions } from './modules/deals/contracts.js';
import { DealsModule } from './modules/deals/deals.module.js';
import type { DiagnosticsModuleOptions } from './modules/diagnostics/contracts.js';
import { DiagnosticsModule } from './modules/diagnostics/diagnostics.module.js';
import type { BriefExportService } from './modules/exports/contracts.js';
import { ExportsModule } from './modules/exports/exports.module.js';
import { HealthModule, type HealthModuleOptions } from './modules/health/health.module.js';
import type { WorkflowApiOptions } from './modules/runs/contracts.js';
import { RunsModule } from './modules/runs/runs.module.js';

/** Composes the API delivery modules with their externally supplied dependencies. */
@Module({})
export class AppModule {
  /** Registers the API modules and their optional delivery-layer ports. */
  public static register(
    authOptions: AuthModuleOptions,
    workflowOptions?: WorkflowApiOptions,
    diagnosticsOptions?: DiagnosticsModuleOptions,
    dealsOptions?: DealsModuleOptions,
    briefExportService?: BriefExportService,
    healthOptions?: HealthModuleOptions
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule.register(healthOptions),
        AuthModule.register(authOptions),
        ...(diagnosticsOptions === undefined
          ? []
          : [DiagnosticsModule.register(diagnosticsOptions)]),
        ...(workflowOptions === undefined
          ? []
          : [
              RunsModule.register(workflowOptions),
              ApprovalsModule.register(
                workflowOptions.decideApproval,
                workflowOptions.approvalQueries
              )
            ]),
        ...(dealsOptions === undefined ? [] : [DealsModule.register(dealsOptions)]),
        ...(briefExportService === undefined ? [] : [ExportsModule.register(briefExportService)])
      ]
    };
  }
}
