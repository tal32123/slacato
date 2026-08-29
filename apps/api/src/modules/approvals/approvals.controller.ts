import { Controller, Inject, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { approvalDecisionRequestSchema, approvalDecisionResultSchema, type ApprovalDecisionRequest } from '@slacato/contracts';
import { ZodBody, ZodResponse } from '../../common/wire/zod.decorators.js';
import { DECIDE_APPROVAL, toHttpError } from '../runs/contracts.js';
import type { DecideApproval } from '@slacato/core';

const decisionSchema = approvalDecisionRequestSchema;
const resultSchema = approvalDecisionResultSchema;
type DecisionInput = ApprovalDecisionRequest;

@Controller('api/approvals')
export class ApprovalsController {
  public constructor(@Inject(DECIDE_APPROVAL) private readonly decideApproval: DecideApproval) {}

  @Post('decisions')
  @ZodResponse(resultSchema)
  public async execute(@ZodBody(decisionSchema) input: DecisionInput, @Req() request: AuthenticatedRequest) {
    const actorId = request.auth?.persona.userId;
    if (actorId === undefined) throw new Error('Authenticated request identity was not installed');
    try {
      return await this.decideApproval.execute({ ...input, actorId });
    } catch (error) {
      return toHttpError(error);
    }
  }
}
