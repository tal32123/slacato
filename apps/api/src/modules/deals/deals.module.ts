import { DynamicModule, Module } from '@nestjs/common';
import { DEALS_OPTIONS, type DealsModuleOptions } from './contracts.js';
import { DealsController } from './deals.controller.js';
import { DealsService } from './deals.service.js';

/** Exposes configured deal-management capabilities to the API. */
@Module({})
export class DealsModule {
  /** Creates the NestJS module definition for the supplied deals options. */
  public static register(options: DealsModuleOptions): DynamicModule {
    return {
      module: DealsModule,
      controllers: [DealsController],
      providers: [
        { provide: DEALS_OPTIONS, useValue: options },
        DealsService
      ]
    };
  }
}
