import { Controller, Inject, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { z } from 'zod';
import { ZodBody, ZodResponse } from '../../common/wire/zod.decorators.js';
import { START_DEAL_BRIEF, toHttpError } from './contracts.js';
import type { StartDealBrief } from '@slacato/core';

const startSchema = z.object({
  opportunityId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256),
  generationProvider: z.string().min(1),
  generationModel: z.string().min(1),
  budget: z.object({
    maxCalls: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    deadlineMs: z.number().int().min(1_000)
  }).strict()
}).strict();
const runResponseSchema = z.object({ runId: z.string().min(1) }).strict();
type StartInput = z.infer<typeof startSchema>;

@Controller('api/runs')
export class RunsController {
  public constructor(@Inject(START_DEAL_BRIEF) private readonly startDealBrief: StartDealBrief) {}

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
}
