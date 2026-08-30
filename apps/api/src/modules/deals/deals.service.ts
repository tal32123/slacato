import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  type DealListItem,
  type DealWorkspaceView,
  dealWorkspaceViewSchema
} from '@slacato/contracts';
import type { DealQuerySession, EvidenceScope } from '@slacato/core';
import { DEALS_OPTIONS, type DealsModuleOptions } from './contracts.js';
import {
  legacyBriefForWorkspace,
  mapAuthorizedDealToListItem,
  projectAuthorizedWorkspaceEvidence,
  renderGeneratedOutput,
  renderSourceSnapshot
} from './deal-workspace.mapper.js';

/** Authorizes deal queries, fetches their source data, and orchestrates workspace rendering. */
@Injectable()
export class DealsService {
  /** Creates the service with its configured deal repository and workspace dependencies. */
  public constructor(@Inject(DEALS_OPTIONS) private readonly options: DealsModuleOptions) {}

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
    const workspaceEvidence = projectAuthorizedWorkspaceEvidence(
      opportunityRows,
      stakeholderRows,
      supplementalRows
    );
    const deal = mapAuthorizedDealToListItem(
      { ...target, recordContent: workspaceEvidence.opportunityRecord?.content ?? null },
      latestRun ?? null
    );
    const sourceSnapshot = renderSourceSnapshot({
      deal,
      opportunityRecord: workspaceEvidence.opportunityRecord,
      stakeholderEvidence: workspaceEvidence.stakeholderEvidence,
      evidence: workspaceEvidence.evidence
    });
    const generatedOutput = renderGeneratedOutput({
      generatedOutput: latestRun?.generatedOutput ?? null,
      producingRun: latestRun,
      evidence: workspaceEvidence.evidence
    });
    const brief = legacyBriefForWorkspace(sourceSnapshot, generatedOutput);

    return dealWorkspaceViewSchema.parse({
      sessionVersion: session.claims.version,
      deal,
      sourceSnapshot,
      generatedOutput,
      brief,
      evidence: workspaceEvidence.evidence
    });
  }
}
