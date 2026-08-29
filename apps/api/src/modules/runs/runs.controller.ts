import { Controller, Inject, Post } from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { z } from 'zod';
import { cancelRunResponseSchema, startBriefRequestSchema, startBriefResponseSchema, type StartBriefRequest } from '@slacato/contracts';
import { ZodBody, ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import { CANCEL_DEAL_BRIEF, REGENERATE_DEAL_BRIEF, START_DEAL_BRIEF, toHttpError } from './contracts.js';
import type { CancelDealBrief, RegenerateDealBrief, StartDealBrief } from '@slacato/core';

const startSchema = startBriefRequestSchema;
const runResponseSchema = startBriefResponseSchema;
type StartInput = StartBriefRequest;
const regenerateSchema = z.object({ idempotencyKey: z.string().min(1).max(256) }).strict();
const regenerateParamsSchema = z.object({ runId: z.string().min(1) }).strict();
type RegenerateParams = z.infer<typeof regenerateParamsSchema>;
type RegenerateInput = z.infer<typeof regenerateSchema>;

/** Starts, cancels, and regenerates deal-brief runs for the current principal. */
@Controller('api/runs')
export class RunsController {
  public constructor(
    @Inject(START_DEAL_BRIEF) private readonly startDealBrief: StartDealBrief,
    @Inject(REGENERATE_DEAL_BRIEF) private readonly regenerateDealBrief: RegenerateDealBrief,
    @Inject(CANCEL_DEAL_BRIEF) private readonly cancelDealBrief: CancelDealBrief
  ) {}

  /** Starts a deal-brief run requested by the current principal. */
  @Post('deal-brief')
  @ZodResponse(runResponseSchema)
  public async start(@ZodBody(startSchema) input: StartInput, @CurrentPrincipal() principal: AuthenticatedPrincipal) {
    try {
      const runId = await this.startDealBrief.execute({ ...input, requestedBy: principal.persona.userId });
      return { runId };
    } catch (error) {
      return toHttpError(error);
    }
  }

  /** Cancels a deal-brief run on behalf of the current principal. */
  @Post(':runId/cancel')
  @ZodResponse(cancelRunResponseSchema)
  public async cancel(@ZodParam(regenerateParamsSchema) params: RegenerateParams, @CurrentPrincipal() principal: AuthenticatedPrincipal) {
    try {
      const run = await this.cancelDealBrief.execute({ runId: params.runId, requestedBy: principal.persona.userId });
      return { runId: run.id, status: 'cancelled' as const, version: run.version };
    } catch (error) {
      return toHttpError(error);
    }
  }

  /** Regenerates a deal-brief run on behalf of the current principal. */
  @Post(':runId/regenerate')
  @ZodResponse(runResponseSchema)
  public async regenerate(@ZodParam(regenerateParamsSchema) params: RegenerateParams, @ZodBody(regenerateSchema) input: RegenerateInput, @CurrentPrincipal() principal: AuthenticatedPrincipal) {
    try {
      return { runId: await this.regenerateDealBrief.execute({
        runId: params.runId, requestedBy: principal.persona.userId, idempotencyKey: input.idempotencyKey
      }) };
    } catch (error) {
      return toHttpError(error);
    }
  }
}
