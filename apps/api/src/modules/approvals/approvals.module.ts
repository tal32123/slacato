import { DynamicModule, Module } from '@nestjs/common';
import type { DecideApproval } from '@slacato/core';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsQueryController } from './approvals-query.controller.js';
import {
  APPROVAL_QUERIES,
  DECIDE_APPROVAL,
  type ApprovalQueryRepository
} from '../runs/contracts.js';

/** Configures the API endpoints and dependencies for approval decisions and queries. */
@Module({})
export class ApprovalsModule {
  /** Creates an approvals module bound to the supplied decision service and optional query repository. */
  public static register(decideApproval: DecideApproval, approvalQueries?: ApprovalQueryRepository): DynamicModule {
    return {
      module: ApprovalsModule,
      controllers: [ApprovalsController, ...(approvalQueries === undefined ? [] : [ApprovalsQueryController])],
      providers: [
        { provide: DECIDE_APPROVAL, useValue: decideApproval },
        ...(approvalQueries === undefined ? [] : [{ provide: APPROVAL_QUERIES, useValue: approvalQueries }])
      ]
    };
  }
}
