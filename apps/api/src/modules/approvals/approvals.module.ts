import { type DynamicModule, Module } from '@nestjs/common';
import type { DecideApproval } from '@slacato/core';
import {
  APPROVAL_QUERIES,
  type ApprovalQueryRepository,
  DECIDE_APPROVAL
} from '../runs/contracts.js';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsQueryController } from './approvals-query.controller.js';

/** Exposes approval decisions and optional approval queries through the API. */
@Module({})
export class ApprovalsModule {
  /** Creates the approvals module with its decision handler and optional query repository. */
  public static register(
    decideApproval: DecideApproval,
    approvalQueryRepository?: ApprovalQueryRepository
  ): DynamicModule {
    return {
      module: ApprovalsModule,
      controllers: [
        ApprovalsController,
        ...(approvalQueryRepository === undefined ? [] : [ApprovalsQueryController])
      ],
      providers: [
        { provide: DECIDE_APPROVAL, useValue: decideApproval },
        ...(approvalQueryRepository === undefined
          ? []
          : [{ provide: APPROVAL_QUERIES, useValue: approvalQueryRepository }])
      ]
    };
  }
}
