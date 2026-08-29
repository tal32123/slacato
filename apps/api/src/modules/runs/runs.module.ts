import { DynamicModule, Module } from '@nestjs/common';
import { RunsController } from './runs.controller.js';
import { START_DEAL_BRIEF, type WorkflowApiOptions } from './contracts.js';

@Module({})
export class RunsModule {
  public static register(options: WorkflowApiOptions): DynamicModule {
    return {
      module: RunsModule,
      controllers: [RunsController],
      providers: [{ provide: START_DEAL_BRIEF, useValue: options.startDealBrief }]
    };
  }
}
