import { Controller, Get } from '@nestjs/common';
import {
  dealListResponseSchema,
  dealWorkspaceViewSchema,
  opaqueIdSchema,
  type DealListResponse,
  type DealWorkspaceView
} from '@slacato/contracts';
import { z } from 'zod';
import { ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { DealsService } from './deals.service.js';

const dealParamsSchema = z.object({ opportunityId: opaqueIdSchema }).strict();

/** Serves deal listings and workspaces authorized for the current principal. */
@Controller('api/deals')
export class DealsController {
  public constructor(private readonly deals: DealsService) {}

  /** Lists the deals visible to the current principal. */
  @Get()
  @ZodResponse(dealListResponseSchema)
  public async list(@CurrentPrincipal() principal: AuthenticatedPrincipal): Promise<DealListResponse> {
    return dealListResponseSchema.parse({
      sessionVersion: principal.claims.version,
      deals: await this.deals.listAuthorizedDeals(principal)
    });
  }

  /** Returns one authorized deal workspace. */
  @Get(':opportunityId')
  @ZodResponse(dealWorkspaceViewSchema)
  public workspace(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @ZodParam(dealParamsSchema) params: z.infer<typeof dealParamsSchema>
  ): Promise<DealWorkspaceView> {
    return this.deals.getAuthorizedDealWorkspace(principal, params.opportunityId);
  }
}

