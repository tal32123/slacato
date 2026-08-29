import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  dealListItemSchema,
  dealWorkspaceViewSchema,
  type BriefSectionView,
  type DealBriefView,
  type DealListItem,
  type DealWorkspaceView,
  type EvidenceDetail,
  type RecommendedActionView,
  type ReviewWarningView,
  type StakeholderView
} from '@slacato/contracts';
import type { PermissionGrant } from '@slacato/core';
import {
  DEALS_OPTIONS,
  type AuthorizedDealRow,
  type DealQuerySession,
  type DealsModuleOptions,
  type EvidenceRow,
  type EvidenceScope,
  type LatestRunRow
} from './contracts.js';

const sectionTitles = {
  dealSnapshot: 'Deal Snapshot',
  executiveSummary: 'Executive Summary',
  buyerGoalsAndBusinessDrivers: 'Buyer Goals and Business Drivers',
  stakeholderMap: 'Stakeholder Map',
  negotiationState: 'Negotiation State',
  recommendedNextActions: 'Recommended Next Actions',
  missingInformation: 'Missing Information',
  sourceEvidence: 'Source Evidence',
  confidenceAndReviewWarnings: 'Confidence and Review Warnings'
} as const;

@Injectable()
export class DealsService {
  public constructor(@Inject(DEALS_OPTIONS) private readonly options: DealsModuleOptions) {}

  public async listAuthorizedDeals(session: DealQuerySession): Promise<DealListItem[]> {
    const access = readableAccounts(session.persona.grants);
    const rows = await this.options.repository.listAuthorizedDeals(
      access.accountIds,
      access.restrictedAccountIds,
      access.salesforceAccountIds,
      access.restrictedSalesforceAccountIds
    );
    return rows.map((row) => mapDeal(row, row.latest_run_status === null || row.latest_run_updated_at === null ? undefined : {
      status: row.latest_run_status,
      updated_at: row.latest_run_updated_at
    }));
  }

  public async getAuthorizedDealWorkspace(session: DealQuerySession, opportunityId: string): Promise<DealWorkspaceView> {
    const access = readableAccounts(session.persona.grants);
    const target = await this.options.repository.findAuthorizedDeal(opportunityId, access.accountIds, access.restrictedAccountIds);
    if (target === undefined) this.forbidden();

    const grants = session.persona.grants.filter((grant) =>
      grant.accountId === target.account_id
      && grant.canRead
      && (!target.restricted || grant.canReadRestricted)
    );
    const scope: EvidenceScope = {
      opportunityId: target.opportunity_id,
      accountId: target.account_id,
      sourceTypes: [...new Set(grants.map((grant) => grant.sourceType))].sort(),
      canViewSensitivePricing: grants.some((grant) => grant.sourceType === 'pricing' && grant.sensitivePricing),
      canViewRestrictedEvidence: grants.some((grant) => grant.canReadRestricted)
    };

    const [latestRun, opportunityRows, stakeholderRows, supplementalRows] = await Promise.all([
      this.options.repository.findLatestRun(target.opportunity_id),
      this.options.repository.listEvidence(scope, 'opportunity'),
      this.options.repository.listEvidence(scope, 'stakeholders'),
      this.options.repository.listEvidence(scope, 'supplemental')
    ]);
    const evidence = [...opportunityRows, ...stakeholderRows, ...supplementalRows].map(mapEvidence);
    const opportunityRecord = opportunityRows[0];
    const fields = parseRecord(opportunityRecord?.content ?? '');
    const deal = mapDeal({ ...target, record_content: opportunityRecord?.content ?? null }, latestRun);
    const brief = buildBrief(deal, fields, stakeholderRows, evidence);

    return dealWorkspaceViewSchema.parse({ sessionVersion: session.claims.version, deal, brief, evidence });
  }

  private forbidden(): never {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Request could not be authorized' });
  }
}

function readableAccounts(grants: readonly PermissionGrant[]): Readonly<{
  accountIds: readonly string[];
  restrictedAccountIds: readonly string[];
  salesforceAccountIds: readonly string[];
  restrictedSalesforceAccountIds: readonly string[];
}> {
  const readable = grants.filter((grant) => grant.canRead);
  const salesforce = readable.filter((grant) => grant.sourceType === 'salesforce');
  return {
    accountIds: [...new Set(readable.map((grant) => grant.accountId))].sort(),
    restrictedAccountIds: [...new Set(readable.filter((grant) => grant.canReadRestricted).map((grant) => grant.accountId))].sort(),
    salesforceAccountIds: [...new Set(salesforce.map((grant) => grant.accountId))].sort(),
    restrictedSalesforceAccountIds: [...new Set(salesforce.filter((grant) => grant.canReadRestricted).map((grant) => grant.accountId))].sort()
  };
}

function mapDeal(row: AuthorizedDealRow, latestRun: LatestRunRow | undefined): DealListItem {
  const fields = parseRecord(row.record_content ?? '');
  return dealListItemSchema.parse({
    opportunityId: row.opportunity_id,
    opportunityName: fields.opportunityName ?? row.opportunity_name,
    accountName: fields.accountName ?? row.account_name,
    stage: fields.stage ?? 'Stage unavailable',
    owner: fields.owner ?? null,
    closeDate: isoDateOrNull(fields.closeDate),
    amount: numberOrNull(fields.acv),
    currency: null,
    probability: numberOrNull(fields.probability),
    riskLevel: riskLevel(fields.riskLevel),
    restricted: row.restricted,
    createdAt: toIsoDateTime(row.created_at),
    latestRun: latestRun === undefined ? null : { status: latestRun.status, updatedAt: toIsoDateTime(latestRun.updated_at) }
  });
}

function mapEvidence(row: EvidenceRow): EvidenceDetail {
  const fields = parseRecord(row.content);
  const sourcePath = (row.source_locator ?? 'source/unavailable').split('#', 1)[0] ?? 'source/unavailable';
  const identity = stableIdentity(sourcePath, fields, row.source_locator, row.id);
  return {
    id: row.id,
    sourceType: row.source_type as EvidenceDetail['sourceType'],
    sourcePath,
    stableKey: identity.key,
    stableId: identity.id,
    citationLabel: `source=${sourcePath}, ${identity.key}=${identity.id}`,
    chunkId: row.id,
    capturedAt: row.event_date === null ? toIsoDateTime(row.created_at) : `${row.event_date}T00:00:00.000Z`,
    content: row.content
  };
}

function stableIdentity(sourcePath: string, fields: Readonly<Record<string, string>>, locator: string | null, fallback: string): Readonly<{ key: string; id: string }> {
  if (sourcePath.endsWith('/opportunities.tsv')) return { key: 'opportunity_id', id: fields.opportunityId ?? locatorId(locator) ?? fallback };
  if (sourcePath.endsWith('/accounts.tsv')) return { key: 'account_id', id: fields.accountId ?? locatorId(locator) ?? fallback };
  if (sourcePath.endsWith('/contacts.tsv')) return { key: 'contact_id', id: fields.contactId ?? locatorId(locator) ?? fallback };
  if (sourcePath.includes('/gong_call_summaries.tsv') || sourcePath.includes('/transcripts/')) return { key: 'call_id', id: fields.callId ?? callIdFromPath(sourcePath) ?? locatorId(locator) ?? fallback };
  if (sourcePath.endsWith('/pricing_notes.tsv')) return { key: 'pricing_note_id', id: fields.pricingNoteId ?? locatorId(locator) ?? fallback };
  if (sourcePath.endsWith('/account_team_updates.tsv')) return { key: 'update_id', id: fields.updateId ?? locatorId(locator) ?? fallback };
  if (sourcePath.endsWith('/deal_desk_policy.md')) return { key: 'policy_id', id: 'deal-desk-policy' };
  return { key: 'record_id', id: locatorId(locator) ?? fallback };
}

function buildBrief(deal: DealListItem, fields: Readonly<Record<string, string>>, stakeholderRows: readonly EvidenceRow[], evidence: readonly EvidenceDetail[]): DealBriefView {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const opportunity = evidence.find((item) => item.sourcePath.endsWith('/opportunities.tsv'));
  const latestConversation = evidence.filter((item) => item.sourceType === 'gong_summary').sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0];
  const slack = evidence.filter((item) => item.sourceType === 'slack');
  const gapUpdate = slack.find((item) => /not yet|does not contain|no confirmed|missing|incomplete/i.test(item.content));
  const alignmentUpdate = slack.find((item) => item.id !== gapUpdate?.id) ?? slack[0];
  const conversationFields = parseRecord(latestConversation?.content ?? '');
  const gapFields = parseRecord(gapUpdate?.content ?? '');
  const stakeholders = stakeholderRows.map(mapStakeholder);
  const actions = buildActions(deal, fields, opportunity, latestConversation, gapUpdate, gapFields);
  const warnings = buildWarnings(deal, opportunity, gapUpdate, gapFields);
  const opportunityCitation = ids(opportunity);
  const conversationCitation = ids(latestConversation);
  const gapCitation = ids(gapUpdate);
  const stakeholderCitations = stakeholders.flatMap((stakeholder) => stakeholder.citationIds);
  const representativeEvidence = evidence.slice(0, 12);

  const sections = {
    dealSnapshot: section('dealSnapshot', [
      `${deal.accountName} is at ${deal.stage} with ${deal.probability === null ? 'an unrecorded' : `${deal.probability}%`} probability.`,
      deal.closeDate === null ? 'No close date is recorded.' : `The recorded close date is ${deal.closeDate}.`
    ], [fields.type, fields.forecastCategory].filter(isPresent), opportunityCitation),
    executiveSummary: section('executiveSummary', [
      conversationFields.summary ?? `The authorized source record places this opportunity at ${deal.stage}.`,
      alignmentUpdate === undefined ? 'No authorized account-team update is available.' : parseRecord(alignmentUpdate.content).updateText ?? alignmentUpdate.content
    ], [], [...conversationCitation, ...ids(alignmentUpdate)], alignmentUpdate !== undefined),
    buyerGoalsAndBusinessDrivers: section('buyerGoalsAndBusinessDrivers', [conversationFields.summary ?? 'Buyer goals require confirmation from authorized conversation evidence.'], splitList(conversationFields.keyPoints), conversationCitation),
    stakeholderMap: section('stakeholderMap', [stakeholders.length === 0 ? 'No authorized stakeholder records are available.' : `${stakeholders.length} authorized stakeholder records are available for review.`], stakeholders.map((stakeholder) => `${stakeholder.name} — ${stakeholder.role}`), stakeholderCitations),
    negotiationState: section('negotiationState', [conversationFields.risks ?? `${deal.riskLevel} risk is recorded for the opportunity.`, gapFields.updateText ?? 'No later authorized account-team change is recorded.'], [fields.nextStep].filter(isPresent), [...conversationCitation, ...gapCitation], gapUpdate !== undefined),
    recommendedNextActions: section('recommendedNextActions', ['Complete the source-backed actions before treating the brief as ready for external use.'], actions.map((action) => action.action), actions.flatMap((action) => action.citationIds), actions.some((action) => action.accountTeamUpdateImpact)),
    missingInformation: section('missingInformation', [gapFields.updateText ?? 'No explicit authorized account-team information gap is recorded.'], gapUpdate === undefined ? [] : ['Confirm this account-team gap with the named owner.'], gapCitation, gapUpdate !== undefined),
    sourceEvidence: section('sourceEvidence', [`${evidence.length} authorized source records support this workspace. Citation controls open representative immutable record identifiers.`], representativeEvidence.map((item) => item.citationLabel), representativeEvidence.map((item) => item.id)),
    confidenceAndReviewWarnings: section('confidenceAndReviewWarnings', [`Overall source-backed confidence is ${Math.round(confidenceForRisk(deal.riskLevel) * 100)}%.`], warnings.map((warning) => warning.message), warnings.flatMap((warning) => warning.citationIds), warnings.some((warning) => warning.accountTeamUpdateImpact))
  };

  for (const citationId of Object.values(sections).flatMap((entry) => entry.citationIds)) {
    if (!evidenceById.has(citationId)) throw new Error(`Brief citation ${citationId} is not authorized for this workspace`);
  }
  return { status: 'source_backed', overallConfidence: confidenceForRisk(deal.riskLevel), sections, stakeholders, actions, warnings };
}

function section(id: keyof typeof sectionTitles, paragraphs: readonly string[], items: readonly string[], citationIds: readonly string[], accountTeamUpdateImpact = false): BriefSectionView {
  return { title: sectionTitles[id], paragraphs: paragraphs.filter(isPresent), items: items.filter(isPresent), citationIds: [...new Set(citationIds)], accountTeamUpdateImpact };
}

function mapStakeholder(row: EvidenceRow): StakeholderView {
  const fields = parseRecord(row.content);
  return {
    name: fields.fullName ?? 'Unnamed stakeholder', title: fields.title ?? null,
    role: fields.roleInDeal ?? 'Role not recorded', influence: fields.influenceLevel ?? 'unknown',
    relationship: (fields.sentiment ?? 'unknown').replaceAll('_', ' '), goals: [],
    concerns: fields.notes === undefined ? [] : [fields.notes], citationIds: [row.id]
  };
}

function buildActions(deal: DealListItem, fields: Readonly<Record<string, string>>, opportunity: EvidenceDetail | undefined, conversation: EvidenceDetail | undefined, gapUpdate: EvidenceDetail | undefined, gapFields: Readonly<Record<string, string>>): RecommendedActionView[] {
  const actions: RecommendedActionView[] = [];
  if (fields.nextStep !== undefined) actions.push({
    action: fields.nextStep, owner: deal.owner, priority: deal.riskLevel === 'high' ? 'critical' : 'high',
    dueDate: dateInside(fields.nextStep), rationale: 'This is the next step recorded in the authorized opportunity source.',
    citationIds: ids(opportunity), accountTeamUpdateImpact: false
  });
  if (gapUpdate !== undefined) actions.push({
    action: 'Confirm the latest account-team information gap before finalizing the packet.', owner: deal.owner,
    priority: 'high', dueDate: deal.closeDate, rationale: gapFields.updateText ?? gapUpdate.content,
    citationIds: [gapUpdate.id], accountTeamUpdateImpact: true
  });
  else if (conversation !== undefined) {
    const conversationFields = parseRecord(conversation.content);
    actions.push({
      action: conversationFields.nextSteps ?? 'Confirm the next negotiation step with the account team.', owner: deal.owner,
      priority: 'medium', dueDate: dateInside(conversationFields.nextSteps),
      rationale: 'This action is grounded in the latest authorized conversation summary.', citationIds: [conversation.id],
      accountTeamUpdateImpact: false
    });
  }
  return actions;
}

function buildWarnings(deal: DealListItem, opportunity: EvidenceDetail | undefined, gapUpdate: EvidenceDetail | undefined, gapFields: Readonly<Record<string, string>>): ReviewWarningView[] {
  const warnings: ReviewWarningView[] = [{
    severity: deal.riskLevel === 'high' ? 'critical' : deal.riskLevel === 'medium' ? 'warning' : 'info',
    message: `${deal.riskLevel[0]?.toUpperCase()}${deal.riskLevel.slice(1)} opportunity risk is recorded; seller review remains required.`,
    citationIds: ids(opportunity), accountTeamUpdateImpact: false
  }];
  if (gapUpdate !== undefined) warnings.push({ severity: 'warning', message: gapFields.updateText ?? gapUpdate.content, citationIds: [gapUpdate.id], accountTeamUpdateImpact: true });
  return warnings;
}

function parseRecord(content: string): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value) fields[key] = value;
  }
  return fields;
}

function ids(item: EvidenceDetail | undefined): string[] { return item === undefined ? [] : [item.id]; }
function isPresent(value: string | undefined): value is string { return value !== undefined && value.length > 0; }
function splitList(value: string | undefined): string[] { return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []; }
function numberOrNull(value: string | undefined): number | null { const parsed = value === undefined ? Number.NaN : Number(value); return Number.isFinite(parsed) ? parsed : null; }
function isoDateOrNull(value: string | undefined): string | null { return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null; }
function dateInside(value: string | undefined): string | null { return value?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null; }
function riskLevel(value: string | undefined): DealListItem['riskLevel'] { return value === 'low' || value === 'medium' || value === 'high' ? value : 'unknown'; }
function confidenceForRisk(value: DealListItem['riskLevel']): number { return value === 'low' ? 0.82 : value === 'medium' ? 0.7 : value === 'high' ? 0.55 : 0.5; }
function toIsoDateTime(value: Date | string): string { return (value instanceof Date ? value : new Date(value)).toISOString(); }
function locatorId(locator: string | null): string | undefined { return locator?.split('#')[1]?.split('/')[0]; }
function callIdFromPath(path: string): string | undefined { return path.match(/(CALL-\d+)/)?.[1]; }
