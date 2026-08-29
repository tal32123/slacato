import { Controller, Inject, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { approvalDecisionRequestSchema, approvalDecisionResultSchema, type ApprovalDecisionRequest } from '@slacato/contracts';
import { ZodBody, ZodResponse } from '../../common/wire/zod.decorators.js';
import { DECIDE_APPROVAL, toHttpError } from '../runs/contracts.js';
import type { DecideApproval } from '@slacato/core';
import { logger } from '@slacato/infrastructure';

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
    const correlationId = `approval_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    try {
      const result = await this.decideApproval.execute({ ...input, actorId });
      logger.info({
        event: 'approval_decision_completed', correlationId, runId: input.runId,
        attemptId: input.approvalSubjectId, status: result.status, durationMs: Date.now() - startedAt,
        retryCount: result.replayed ? 1 : 0
      });
      return result;
    } catch (error) {
      const candidate = error as { code?: unknown };
      const errorCode = typeof candidate.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(candidate.code)
        ? candidate.code : 'APPROVAL_DECISION_FAILED';
      logger.error({
        event: 'approval_decision_failed', correlationId, runId: input.runId,
        attemptId: input.approvalSubjectId, status: 'failed', durationMs: Date.now() - startedAt,
        retryCount: 0, errorCode
      });
      return toHttpError(error);
    }
  }
}
