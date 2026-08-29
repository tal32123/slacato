import { DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import {
  APPROVAL_AUTHORITY_QUERY,
  PROVIDER_RUNTIME_DESCRIPTOR,
  type DiagnosticsModuleOptions
} from './contracts.js';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics.service.js';

/** Makes provider runtime and approval-authority diagnostics available through the diagnostics API. */
@Module({})
export class DiagnosticsModule {
  /** Builds the diagnostics module with the runtime facts and approval-authority query it needs. */
  public static register(options: DiagnosticsModuleOptions): DynamicModule {
    return {
      module: DiagnosticsModule,
      imports: [HealthModule],
      controllers: [DiagnosticsController],
      providers: [
        { provide: PROVIDER_RUNTIME_DESCRIPTOR, useValue: options.providerRuntime },
        { provide: APPROVAL_AUTHORITY_QUERY, useValue: options.approvalAuthorities },
        DiagnosticsService
      ]
    };
  }
}
