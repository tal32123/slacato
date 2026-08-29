import { DynamicModule, Module } from '@nestjs/common';
import { RunEventsController } from './run-events.controller.js';
import { RunsController } from './runs.controller.js';
import {
  REGENERATE_DEAL_BRIEF,
  RUN_EVENT_BUS,
  RUN_EVENT_HEARTBEAT_MS,
  RUN_EVENT_QUERY,
  START_DEAL_BRIEF,
  type WorkflowApiOptions
} from './contracts.js';

@Module({})
export class RunsModule {
  public static register(options: WorkflowApiOptions): DynamicModule {
    return {
      module: RunsModule,
      controllers: [RunsController, ...(options.runEvents === undefined ? [] : [RunEventsController])],
      providers: [
        { provide: START_DEAL_BRIEF, useValue: options.startDealBrief },
        { provide: REGENERATE_DEAL_BRIEF, useValue: options.regenerateDealBrief },
        ...(options.runEvents === undefined ? [] : [
          { provide: RUN_EVENT_BUS, useValue: options.runEvents.bus },
          { provide: RUN_EVENT_QUERY, useValue: options.runEvents.query },
          { provide: RUN_EVENT_HEARTBEAT_MS, useValue: options.runEvents.heartbeatMs ?? 15_000 }
        ])
      ]
    };
  }
}
