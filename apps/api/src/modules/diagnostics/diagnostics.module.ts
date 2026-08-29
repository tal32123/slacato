import { DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { DIAGNOSTICS_OPTIONS, type DiagnosticsModuleOptions } from './contracts.js';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics.service.js';

@Module({})
export class DiagnosticsModule {
  public static register(options: DiagnosticsModuleOptions): DynamicModule {
    return {
      module: DiagnosticsModule,
      imports: [HealthModule],
      controllers: [DiagnosticsController],
      providers: [
        { provide: DIAGNOSTICS_OPTIONS, useValue: options },
        DiagnosticsService
      ]
    };
  }
}
