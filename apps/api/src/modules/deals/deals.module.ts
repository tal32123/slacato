import { DynamicModule, Module } from '@nestjs/common';
import { DEALS_OPTIONS, type DealsModuleOptions } from './contracts.js';
import { DealsController } from './deals.controller.js';
import { DealsService } from './deals.service.js';

@Module({})
export class DealsModule {
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
