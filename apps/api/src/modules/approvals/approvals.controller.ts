import { Controller, Inject, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { z } from 'zod';
import { ZodBody, ZodResponse } from '../../common/wire/zod.decorators.js';
import { DECIDE_APPROVAL, toHttpError } from '../runs/contracts.js';
import type { DecideApproval } from '@slacato/core';

const decisionSchema = z.object({
  runId: z.string().min(1),
  approvalSubjectId: z.string().min(1),
  expectedRunVersion: z.number().int().nonnegative(),
  expectedSubjectHash: z.string().length(64),
  entryId: z.string().min(1),
  category: z.enum(['commercial_discount', 'legal_terms', 'evidence_review', 'customer_concession']),
  authority: z.enum(['deal_desk', 'sales_leader', 'legal_reviewer', 'account_owner']),
  action: z.enum(['approve_unchanged', 'edit_and_approve', 'reject']),
  idempotencyKey: z.string().min(1).max(256),
  rationale: z.string().min(1).optional(),
  editedPayload: z.unknown().optional()
}).strict();
const resultSchema = z.object({
  status: z.enum(['awaiting_approval', 'finalizing', 'rejected']),
  runVersion: z.number().int().nonnegative(),
  approvalSubjectId: z.string(),
  entryId: z.string(),
  approvedSubjectHash: z.string().length(64),
  quorumSatisfied: z.boolean(),
  replayed: z.boolean()
}).strict();
type DecisionInput = z.infer<typeof decisionSchema>;

@Controller('api/approvals')
export class ApprovalsController {
  public constructor(@Inject(DECIDE_APPROVAL) private readonly decideApproval: DecideApproval) {}

  @Post('decisions')
  @ZodResponse(resultSchema)
  public async execute(@ZodBody(decisionSchema) input: DecisionInput, @Req() request: AuthenticatedRequest) {
    const actorId = request.auth?.persona.userId;
    if (actorId === undefined) throw new Error('Authenticated request identity was not installed');
    try {
      return await this.decideApproval.execute({ ...input, actorId });
    } catch (error) {
      return toHttpError(error);
    }
  }
}
