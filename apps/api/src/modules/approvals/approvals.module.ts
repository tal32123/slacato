import { DynamicModule, Module } from '@nestjs/common';
import type { DecideApproval } from '@slacato/core';
import { ApprovalsController } from './approvals.controller.js';
import { DECIDE_APPROVAL } from '../runs/contracts.js';
import { ApprovalsQueryController } from './approvals-query.controller.js';
import { RUN_APPROVAL_QUERIES, type RunApprovalQueryRepository } from '../runs/run-approval.repository.js';

@Module({})
export class ApprovalsModule {
  public static register(decideApproval: DecideApproval, queries?: RunApprovalQueryRepository): DynamicModule {
    return {
      module: ApprovalsModule,
      controllers: [ApprovalsController, ...(queries === undefined ? [] : [ApprovalsQueryController])],
      providers: [
        { provide: DECIDE_APPROVAL, useValue: decideApproval },
        ...(queries === undefined ? [] : [{ provide: RUN_APPROVAL_QUERIES, useValue: queries }])
      ]
    };
  }
}
