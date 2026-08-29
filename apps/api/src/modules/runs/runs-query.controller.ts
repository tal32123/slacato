import { Controller, Get, Inject, NotFoundException, Req } from '@nestjs/common';
import { runDetailResponseSchema, runListResponseSchema } from '@slacato/contracts';
import { z } from 'zod';
import { ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { RUN_APPROVAL_QUERIES, type RunApprovalQueryRepository } from './run-approval.repository.js';

const paramsSchema = z.object({ runId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict();
type RunParams = z.infer<typeof paramsSchema>;

@Controller('api/runs')
export class RunsQueryController {
  public constructor(@Inject(RUN_APPROVAL_QUERIES) private readonly queries: RunApprovalQueryRepository) {}

  @Get()
  @ZodResponse(runListResponseSchema)
  public async list(@Req() request: AuthenticatedRequest) {
    const session = authenticatedSession(request);
    return this.queries.listRuns(session.persona.userId, session.claims.version);
  }

  @Get(':runId/detail')
  @ZodResponse(runDetailResponseSchema)
  public async detail(@ZodParam(paramsSchema) params: RunParams, @Req() request: AuthenticatedRequest) {
    const session = authenticatedSession(request);
    const detail = await this.queries.getRun(session.persona.userId, session.claims.version, params.runId);
    if (detail === undefined) opaqueNotFound();
    return detail;
  }
}

function authenticatedSession(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  if (request.auth === undefined) throw new Error('Authenticated request identity was not installed');
  return request.auth;
}

function opaqueNotFound(): never {
  throw new NotFoundException({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
}
