import { DynamicModule, Module } from '@nestjs/common';
import { RunEventsController } from './run-events.controller.js';
import { RunsController } from './runs.controller.js';
import { RunsQueryController } from './runs-query.controller.js';
import { RUN_APPROVAL_QUERIES } from './run-approval.repository.js';
import {
  CANCEL_DEAL_BRIEF,
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
      controllers: [
        RunsController,
        ...(options.runEvents === undefined ? [] : [RunEventsController]),
        ...(options.queries === undefined ? [] : [RunsQueryController])
      ],
      providers: [
        { provide: START_DEAL_BRIEF, useValue: options.startDealBrief },
        { provide: REGENERATE_DEAL_BRIEF, useValue: options.regenerateDealBrief },
        { provide: CANCEL_DEAL_BRIEF, useValue: options.cancelDealBrief },
        ...(options.queries === undefined ? [] : [{ provide: RUN_APPROVAL_QUERIES, useValue: options.queries }]),
        ...(options.runEvents === undefined ? [] : [
          { provide: RUN_EVENT_BUS, useValue: options.runEvents.bus },
          { provide: RUN_EVENT_QUERY, useValue: options.runEvents.query },
          { provide: RUN_EVENT_HEARTBEAT_MS, useValue: options.runEvents.heartbeatMs ?? 15_000 }
        ])
      ]
    };
  }
}
