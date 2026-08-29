import { Controller, Inject, Post } from '@nestjs/common';
import {
  type ApprovalDecisionRequest,
  approvalDecisionRequestSchema,
  approvalDecisionResultSchema
} from '@slacato/contracts';
import type { DecideApproval } from '@slacato/core';
import { logger } from '@slacato/infrastructure';
import { toHttpError } from '../../common/http/to-http-error.js';
import { ZodBody, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { DECIDE_APPROVAL } from '../runs/contracts.js';

const decisionSchema = approvalDecisionRequestSchema;
const resultSchema = approvalDecisionResultSchema;
type DecisionInput = ApprovalDecisionRequest;

/** Executes authenticated approval decisions and emits their operational outcome. */
@Controller('api/approvals')
export class ApprovalsController {
  /** Initializes the controller with the approval decision use case. */
  public constructor(@Inject(DECIDE_APPROVAL) private readonly decideApproval: DecideApproval) {}

  /** Applies one approval decision on behalf of the current authenticated principal. */
  @Post('decisions')
  @ZodResponse(resultSchema)
  public async execute(
    @ZodBody(decisionSchema) input: DecisionInput,
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ) {
    const actorId = principal.persona.userId;
    const correlationId = `approval_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    try {
      const result = await this.decideApproval.execute({ ...input, actorId });
      logger.info({
        event: 'approval_decision_completed',
        correlationId,
        runId: input.runId,
        attemptId: input.approvalSubjectId,
        status: result.status,
        durationMs: Date.now() - startedAt,
        retryCount: result.replayed ? 1 : 0
      });
      return result;
    } catch (error) {
      const candidate = error as { code?: unknown };
      const errorCode =
        typeof candidate.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(candidate.code)
          ? candidate.code
          : 'APPROVAL_DECISION_FAILED';
      logger.error({
        event: 'approval_decision_failed',
        correlationId,
        runId: input.runId,
        attemptId: input.approvalSubjectId,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        retryCount: 0,
        errorCode
      });
      return toHttpError(error);
    }
  }
}
