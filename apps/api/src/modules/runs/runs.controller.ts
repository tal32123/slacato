import { Controller, Inject, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { z } from 'zod';
import { startBriefRequestSchema, startBriefResponseSchema, type StartBriefRequest } from '@slacato/contracts';
import { ZodBody, ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import { REGENERATE_DEAL_BRIEF, START_DEAL_BRIEF, toHttpError } from './contracts.js';
import type { RegenerateDealBrief, StartDealBrief } from '@slacato/core';

const startSchema = startBriefRequestSchema;
const runResponseSchema = startBriefResponseSchema;
type StartInput = StartBriefRequest;
const regenerateSchema = z.object({ idempotencyKey: z.string().min(1).max(256) }).strict();
const regenerateParamsSchema = z.object({ runId: z.string().min(1) }).strict();
type RegenerateParams = z.infer<typeof regenerateParamsSchema>;
type RegenerateInput = z.infer<typeof regenerateSchema>;

@Controller('api/runs')
export class RunsController {
  public constructor(
    @Inject(START_DEAL_BRIEF) private readonly startDealBrief: StartDealBrief,
    @Inject(REGENERATE_DEAL_BRIEF) private readonly regenerateDealBrief: RegenerateDealBrief
  ) {}

  @Post('deal-brief')
  @ZodResponse(runResponseSchema)
  public async start(@ZodBody(startSchema) input: StartInput, @Req() request: AuthenticatedRequest) {
    const actorId = request.auth?.persona.userId;
    if (actorId === undefined) throw new Error('Authenticated request identity was not installed');
    try {
      const runId = await this.startDealBrief.execute({ ...input, requestedBy: actorId });
      return { runId };
    } catch (error) {
      return toHttpError(error);
    }
  }

  @Post(':runId/regenerate')
  @ZodResponse(runResponseSchema)
  public async regenerate(@ZodParam(regenerateParamsSchema) params: RegenerateParams, @ZodBody(regenerateSchema) input: RegenerateInput, @Req() request: AuthenticatedRequest) {
    const actorId = request.auth?.persona.userId;
    if (actorId === undefined) throw new Error('Authenticated request identity was not installed');
    try {
      return { runId: await this.regenerateDealBrief.execute({
        runId: params.runId, requestedBy: actorId, idempotencyKey: input.idempotencyKey
      }) };
    } catch (error) {
      return toHttpError(error);
    }
  }
}
