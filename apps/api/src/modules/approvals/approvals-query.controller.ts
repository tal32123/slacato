import { Controller, Get, Inject, NotFoundException, Req } from '@nestjs/common';
import { approvalDetailResponseSchema, approvalInboxResponseSchema } from '@slacato/contracts';
import { z } from 'zod';
import { ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { RUN_APPROVAL_QUERIES, type RunApprovalQueryRepository } from '../runs/run-approval.repository.js';

const paramsSchema = z.object({ subjectId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict();
type ApprovalParams = z.infer<typeof paramsSchema>;

@Controller('api/approvals')
export class ApprovalsQueryController {
  public constructor(@Inject(RUN_APPROVAL_QUERIES) private readonly queries: RunApprovalQueryRepository) {}

  @Get()
  @ZodResponse(approvalInboxResponseSchema)
  public async list(@Req() request: AuthenticatedRequest) {
    const session = authenticatedSession(request);
    return this.queries.listApprovals(session.persona.userId, session.claims.version);
  }

  @Get(':subjectId')
  @ZodResponse(approvalDetailResponseSchema)
  public async detail(@ZodParam(paramsSchema) params: ApprovalParams, @Req() request: AuthenticatedRequest) {
    const session = authenticatedSession(request);
    const detail = await this.queries.getApproval(session.persona.userId, session.claims.version, params.subjectId);
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
