import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import type { DealListItem, DealWorkspaceView } from '@slacato/contracts';
import type { DealQuerySession, EvidenceScope } from '@slacato/core';
import { DEALS_OPTIONS, type DealsModuleOptions } from './contracts.js';
import { mapAuthorizedDealToListItem, renderDealWorkspace } from './deal-workspace.mapper.js';

/** Authorizes deal queries, fetches their source data, and orchestrates workspace rendering. */
@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  /** Creates the service with its configured deal repository and workspace dependencies. */
  public constructor(@Inject(DEALS_OPTIONS) private readonly options: DealsModuleOptions) {}

  /**
   * Audits a refused workspace request without recording what was refused.
   *
   * The refusal itself is never conditional on this write succeeding: a failed insert must not turn
   * a 403 into a 500, because that difference would itself be a signal an unauthorized caller could
   * measure. Nothing about the requested opportunity is recorded or logged - only that this actor
   * was refused - so the record is identical whether the deal exists or not.
   */
  private async auditWorkspaceDenial(actorId: string): Promise<void> {
    try {
      await this.options.denials.recordOpaqueDenial({ actorId, reason: 'forbidden' });
    } catch (error) {
      this.logger.error({
        event: 'denial_audit_write_failed',
        actorId,
        errorCode: 'DENIAL_AUDIT_WRITE_FAILED',
        error: error instanceof Error ? error.message : 'unknown'
      });
    }
  }

  /** Lists deals authorized by the persona's current server-side Salesforce grants. */
  public async listAuthorizedDeals(session: DealQuerySession): Promise<DealListItem[]> {
    const deals = await this.options.repository.listAuthorizedDeals(session.persona.userId);
    return deals.map((deal) => mapAuthorizedDealToListItem(deal));
  }

  /** Loads an authorized deal workspace with source records and generated artifacts as separate representations. */
  public async getAuthorizedDealWorkspace(
    session: DealQuerySession,
    opportunityId: string
  ): Promise<DealWorkspaceView> {
    const target = await this.options.repository.findAuthorizedDeal(
      session.persona.userId,
      opportunityId
    );
    if (target === undefined) {
      await this.auditWorkspaceDenial(session.persona.userId);
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Request could not be authorized'
      });
    }

    const scope: EvidenceScope = {
      personaId: session.persona.userId,
      opportunityId: target.opportunityId,
      accountId: target.accountId,
      restrictedOpportunity: target.restricted
    };
    const [latestRun, opportunityRows, stakeholderRows, supplementalRows] = await Promise.all([
      this.options.repository.findLatestRun(session.persona.userId, target.opportunityId),
      this.options.repository.listEvidence(scope, 'opportunity'),
      this.options.repository.listEvidence(scope, 'stakeholders'),
      this.options.repository.listEvidence(scope, 'supplemental')
    ]);

    return renderDealWorkspace({
      sessionVersion: session.claims.version,
      target,
      latestRun,
      opportunityRows,
      stakeholderRows,
      supplementalRows
    });
  }
}
