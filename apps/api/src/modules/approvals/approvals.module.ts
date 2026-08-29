import { DynamicModule, Module } from '@nestjs/common';
import type { DecideApproval } from '@slacato/core';
import { ApprovalsController } from './approvals.controller.js';
import { DECIDE_APPROVAL } from '../runs/contracts.js';

@Module({})
export class ApprovalsModule {
  public static register(decideApproval: DecideApproval): DynamicModule {
    return {
      module: ApprovalsModule,
      controllers: [ApprovalsController],
      providers: [{ provide: DECIDE_APPROVAL, useValue: decideApproval }]
    };
  }
}
