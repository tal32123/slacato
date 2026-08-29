import { DynamicModule, Module } from '@nestjs/common';
import { ExportsController } from './exports.controller.js';
import { BRIEF_EXPORT_SERVICE, type BriefExportService } from './exports.service.js';

@Module({})
export class ExportsModule {
  public static register(service: BriefExportService): DynamicModule {
    return {
      module: ExportsModule,
      controllers: [ExportsController],
      providers: [{ provide: BRIEF_EXPORT_SERVICE, useValue: service }]
    };
  }
}
