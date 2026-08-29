import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import {
  dealListResponseSchema,
  dealWorkspaceViewSchema,
  type DealListResponse,
  type DealWorkspaceView
} from '@slacato/contracts';
import { z } from 'zod';
import { ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { DealsService } from './deals.service.js';

const dealParamsSchema = z.object({ opportunityId: z.string().min(1).max(128) }).strict();

@Controller('api/deals')
export class DealsController {
  public constructor(private readonly deals: DealsService) {}

  @Get()
  @ZodResponse(dealListResponseSchema)
  public async list(@Req() request: AuthenticatedRequest): Promise<DealListResponse> {
    const session = requireAuth(request);
    return dealListResponseSchema.parse({
      sessionVersion: session.claims.version,
      deals: await this.deals.listAuthorizedDeals(session)
    });
  }

  @Get(':opportunityId')
  @ZodResponse(dealWorkspaceViewSchema)
  public workspace(
    @Req() request: AuthenticatedRequest,
    @ZodParam(dealParamsSchema) params: z.infer<typeof dealParamsSchema>
  ): Promise<DealWorkspaceView> {
    return this.deals.getAuthorizedDealWorkspace(requireAuth(request), params.opportunityId);
  }
}

function requireAuth(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  if (request.auth === undefined) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Authentication is required' });
  return request.auth;
}
