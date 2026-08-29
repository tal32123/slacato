import { Controller, Get, Inject, NotFoundException } from '@nestjs/common';
import { opaqueIdSchema, runDetailResponseSchema, runListResponseSchema } from '@slacato/contracts';
import { z } from 'zod';
import { ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { type QueryPrincipal, RUN_QUERIES, type RunQueryRepository } from './contracts.js';

const paramsSchema = z.object({ runId: opaqueIdSchema }).strict();
type RunParams = z.infer<typeof paramsSchema>;

/** Serves run listings and detail views authorized for the current principal. */
@Controller('api/runs')
export class RunsQueryController {
  /** Initializes the controller with the run query repository. */
  public constructor(@Inject(RUN_QUERIES) private readonly queries: RunQueryRepository) {}

  /** Lists runs visible to the current principal. */
  @Get()
  @ZodResponse(runListResponseSchema)
  public async list(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    const queryPrincipal: QueryPrincipal = {
      actorId: principal.persona.userId,
      sessionVersion: principal.claims.version
    };
    return this.queries.listRuns(queryPrincipal);
  }

  /** Returns one visible run detail or an opaque not-found response. */
  @Get(':runId/detail')
  @ZodResponse(runDetailResponseSchema)
  public async detail(
    @ZodParam(paramsSchema) params: RunParams,
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ) {
    const queryPrincipal: QueryPrincipal = {
      actorId: principal.persona.userId,
      sessionVersion: principal.claims.version
    };
    const detail = await this.queries.getRun(queryPrincipal, params.runId);
    if (detail === undefined) opaqueNotFound();
    return detail;
  }
}

/** Throws an opaque not-found response. */
function opaqueNotFound(): never {
  throw new NotFoundException({
    code: 'NOT_FOUND',
    message: 'The requested resource was not found.'
  });
}
