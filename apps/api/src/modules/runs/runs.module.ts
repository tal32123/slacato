import { DynamicModule, Module } from '@nestjs/common';
import { RunEventsController } from './run-events.controller.js';
import { RunsController } from './runs.controller.js';
import { RunsQueryController } from './runs-query.controller.js';
import {
  CANCEL_DEAL_BRIEF,
  RUN_QUERIES,
  REGENERATE_DEAL_BRIEF,
  RUN_EVENT_BUS,
  RUN_EVENT_HEARTBEAT_MS,
  RUN_EVENT_QUERY,
  START_DEAL_BRIEF,
  type WorkflowApiOptions
} from './contracts.js';

/** Exposes run commands, optional run queries, and run-event streaming through the API. */
@Module({})
export class RunsModule {
  /** Creates the runs module with its command handlers and optional query and event dependencies. */
  public static register(options: WorkflowApiOptions): DynamicModule {
    return {
      module: RunsModule,
      controllers: [
        RunsController,
        ...(options.runEvents === undefined ? [] : [RunEventsController]),
        ...(options.runQueries === undefined ? [] : [RunsQueryController])
      ],
      providers: [
        { provide: START_DEAL_BRIEF, useValue: options.startDealBrief },
        { provide: REGENERATE_DEAL_BRIEF, useValue: options.regenerateDealBrief },
        { provide: CANCEL_DEAL_BRIEF, useValue: options.cancelDealBrief },
        ...(options.runQueries === undefined ? [] : [{ provide: RUN_QUERIES, useValue: options.runQueries }]),
        ...(options.runEvents === undefined ? [] : [
          { provide: RUN_EVENT_BUS, useValue: options.runEvents.bus },
          { provide: RUN_EVENT_QUERY, useValue: options.runEvents.query },
          { provide: RUN_EVENT_HEARTBEAT_MS, useValue: options.runEvents.heartbeatMs ?? 15_000 }
        ])
      ]
    };
  }
}
