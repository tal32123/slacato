import { Controller, Get, Inject, NotFoundException } from '@nestjs/common';
import { approvalDetailResponseSchema, approvalInboxResponseSchema, opaqueIdSchema } from '@slacato/contracts';
import { z } from 'zod';
import { ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { APPROVAL_QUERIES, type ApprovalQueryRepository } from '../runs/contracts.js';

const paramsSchema = z.object({ subjectId: opaqueIdSchema }).strict();
type ApprovalParams = z.infer<typeof paramsSchema>;

/** Serves the approval inbox and opaque approval details for the current principal. */
@Controller('api/approvals')
export class ApprovalsQueryController {
  public constructor(@Inject(APPROVAL_QUERIES) private readonly queries: ApprovalQueryRepository) {}

  /** Lists approvals visible to the current principal. */
  @Get()
  @ZodResponse(approvalInboxResponseSchema)
  public async list(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.queries.listApprovals(principal.persona.userId, principal.claims.version);
  }

  /** Returns one visible approval detail without disclosing unauthorized subjects. */
  @Get(':subjectId')
  @ZodResponse(approvalDetailResponseSchema)
  public async detail(
    @ZodParam(paramsSchema) params: ApprovalParams,
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ) {
    const detail = await this.queries.getApproval(principal.persona.userId, principal.claims.version, params.subjectId);
    if (detail === undefined) opaqueNotFound();
    return detail;
  }
}

function opaqueNotFound(): never {
  throw new NotFoundException({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
}
