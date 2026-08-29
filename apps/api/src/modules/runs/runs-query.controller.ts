import { Controller, Get, Inject, NotFoundException } from '@nestjs/common';
import { runDetailResponseSchema, runListResponseSchema } from '@slacato/contracts';
import { z } from 'zod';
import { ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { RUN_APPROVAL_QUERIES, type RunApprovalQueryRepository } from './run-approval.repository.js';

const paramsSchema = z.object({ runId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict();
type RunParams = z.infer<typeof paramsSchema>;

/** Serves run listings and detail views authorized for the current principal. */
@Controller('api/runs')
export class RunsQueryController {
  public constructor(@Inject(RUN_APPROVAL_QUERIES) private readonly queries: RunApprovalQueryRepository) {}

  /** Lists runs visible to the current principal. */
  @Get()
  @ZodResponse(runListResponseSchema)
  public async list(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.queries.listRuns(principal.persona.userId, principal.claims.version);
  }

  /** Returns one visible run detail or an opaque not-found response. */
  @Get(':runId/detail')
  @ZodResponse(runDetailResponseSchema)
  public async detail(
    @ZodParam(paramsSchema) params: RunParams,
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ) {
    const detail = await this.queries.getRun(principal.persona.userId, principal.claims.version, params.runId);
    if (detail === undefined) opaqueNotFound();
    return detail;
  }
}

function opaqueNotFound(): never {
  throw new NotFoundException({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
}
