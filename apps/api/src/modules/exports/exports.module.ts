import { type DynamicModule, Module } from '@nestjs/common';
import { BRIEF_EXPORT_SERVICE, type BriefExportService } from './contracts.js';
import { ExportsController } from './exports.controller.js';

/** Binds the consumer-owned brief export port to the export delivery controller. */
@Module({})
export class ExportsModule {
  /** Registers the export service supplied by the application composition root. */
  public static register(service: BriefExportService): DynamicModule {
    return {
      module: ExportsModule,
      controllers: [ExportsController],
      providers: [{ provide: BRIEF_EXPORT_SERVICE, useValue: service }]
    };
  }
}
