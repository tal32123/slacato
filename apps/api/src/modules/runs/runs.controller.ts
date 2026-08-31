import { Controller, Inject, Logger, Post, Res } from '@nestjs/common';
import {
  cancelRunResponseSchema,
  opaqueIdSchema,
  type StartBriefRequest,
  startBriefRequestSchema,
  startBriefResponseSchema
} from '@slacato/contracts';
import type { CancelDealBrief, RegenerateDealBrief, StartDealBrief } from '@slacato/core';
import type { Response } from 'express';
import { z } from 'zod';
import { toHttpError } from '../../common/http/to-http-error.js';
import { ZodBody, ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { CANCEL_DEAL_BRIEF, REGENERATE_DEAL_BRIEF, START_DEAL_BRIEF } from './contracts.js';

const startSchema = startBriefRequestSchema;
const runResponseSchema = startBriefResponseSchema;
type StartInput = StartBriefRequest;
const regenerateSchema = z.object({ idempotencyKey: opaqueIdSchema }).strict();
const regenerateParamsSchema = z.object({ runId: opaqueIdSchema }).strict();
type RegenerateParams = z.infer<typeof regenerateParamsSchema>;
type RegenerateInput = z.infer<typeof regenerateSchema>;

/** Starts, cancels, and regenerates deal-brief runs for the current principal. */
@Controller('api/runs')
export class RunsController {
  private readonly logger = new Logger(RunsController.name);

  /** Creates a runs controller with its deal-brief operations. */
  public constructor(
    @Inject(START_DEAL_BRIEF) private readonly startDealBrief: StartDealBrief,
    @Inject(REGENERATE_DEAL_BRIEF) private readonly regenerateDealBrief: RegenerateDealBrief,
    @Inject(CANCEL_DEAL_BRIEF) private readonly cancelDealBrief: CancelDealBrief
  ) {}

  /**
   * Starts a deal-brief run requested by the current principal.
   *
   * One active run per opportunity is a deliberate concurrency guarantee, so a start request can
   * legitimately be answered with a run that is already in flight. The response body cannot say so
   * - it is a strict contract shared with the web client - so the outcome travels as a response
   * header instead, and is logged server-side either way. A client that reads
   * `X-Run-Disposition: joined` knows the user asked for a new brief and was handed an existing
   * one, rather than silently landing on work it did not start.
   */
  @Post('deal-brief')
  @ZodResponse(runResponseSchema)
  public async start(
    @ZodBody(startSchema) input: StartInput,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Res({ passthrough: true }) response: Response
  ) {
    try {
      const outcome = await this.startDealBrief.execute({
        ...input,
        requestedBy: principal.persona.userId
      });
      response.set({ 'X-Run-Disposition': outcome.disposition });
      this.logger.log({
        event: 'deal_brief_start',
        runId: outcome.runId,
        disposition: outcome.disposition
      });
      return { runId: outcome.runId };
    } catch (error) {
      return toHttpError(error);
    }
  }

  /** Cancels a deal-brief run on behalf of the current principal. */
  @Post(':runId/cancel')
  @ZodResponse(cancelRunResponseSchema)
  public async cancel(
    @ZodParam(regenerateParamsSchema) params: RegenerateParams,
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ) {
    try {
      const run = await this.cancelDealBrief.execute({
        runId: params.runId,
        requestedBy: principal.persona.userId
      });
      return { runId: run.id, status: 'cancelled' as const, version: run.version };
    } catch (error) {
      return toHttpError(error);
    }
  }

  /** Regenerates a deal-brief run on behalf of the current principal. */
  @Post(':runId/regenerate')
  @ZodResponse(runResponseSchema)
  public async regenerate(
    @ZodParam(regenerateParamsSchema) params: RegenerateParams,
    @ZodBody(regenerateSchema) input: RegenerateInput,
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ) {
    try {
      return {
        runId: await this.regenerateDealBrief.execute({
          runId: params.runId,
          requestedBy: principal.persona.userId,
          idempotencyKey: input.idempotencyKey
        })
      };
    } catch (error) {
      return toHttpError(error);
    }
  }
}
