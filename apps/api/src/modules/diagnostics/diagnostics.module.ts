import { DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import {
  APPROVAL_AUTHORITY_QUERY,
  PROVIDER_RUNTIME_DESCRIPTOR,
  type DiagnosticsModuleOptions
} from './contracts.js';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics.service.js';

/** Connects diagnostics to runtime facts and canonical approval-authority data supplied by composition. */
@Module({})
export class DiagnosticsModule {
  /** Registers the diagnostics boundary with its concrete runtime and query dependencies. */
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
