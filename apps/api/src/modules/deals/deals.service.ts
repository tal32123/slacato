import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  dealListItemSchema,
  dealWorkspaceViewSchema,
  isoDateSchema,
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
      session.persona.userId,
      access.accountIds,
      access.restrictedAccountIds
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

    const scope: EvidenceScope = {
      personaId: session.persona.userId,
      opportunityId: target.opportunity_id,
      accountId: target.account_id
    };

    const [latestRun, opportunityRows, stakeholderRows, supplementalRows] = await Promise.all([
      this.options.repository.findLatestRun(target.opportunity_id),
      this.options.repository.listEvidence(scope, 'opportunity'),
      this.options.repository.listEvidence(scope, 'stakeholders'),
      this.options.repository.listEvidence(scope, 'supplemental')
    ]);
    const opportunityEvidence = opportunityRows.map(mapEvidence).filter(isDefined);
    const stakeholderEvidence = stakeholderRows.map(mapEvidence).filter(isDefined);
    const supplementalEvidence = supplementalRows.map(mapEvidence).filter(isDefined);
    const evidence = [...opportunityEvidence, ...stakeholderEvidence, ...supplementalEvidence];
    const includedEvidenceIds = new Set(evidence.map((item) => item.id));
    const provenancedStakeholderRows = stakeholderRows.filter((row) => includedEvidenceIds.has(row.id));
    const opportunityRecord = opportunityRows.find((row) => includedEvidenceIds.has(row.id));
    const fields = parseRecord(opportunityRecord?.content ?? '');
    const deal = mapDeal({ ...target, record_content: opportunityRecord?.content ?? null }, latestRun);
    const brief = buildBrief(deal, fields, provenancedStakeholderRows, evidence);

    return dealWorkspaceViewSchema.parse({ sessionVersion: session.claims.version, deal, brief, evidence });
  }

  private forbidden(): never {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Request could not be authorized' });
  }
}

function readableAccounts(grants: readonly PermissionGrant[]): Readonly<{
  accountIds: readonly string[];
  restrictedAccountIds: readonly string[];
}> {
  const readable = grants.filter((grant) => grant.canRead);
  return {
    accountIds: [...new Set(readable.map((grant) => grant.accountId))].sort(),
    restrictedAccountIds: [...new Set(readable.filter((grant) => grant.canReadRestricted).map((grant) => grant.accountId))].sort()
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
    currency: currencyOrNull(fields.currency ?? fields.currencyIsoCode),
    probability: numberOrNull(fields.probability),
    riskLevel: riskLevel(fields.riskLevel),
    restricted: row.restricted,
    createdAt: toIsoDateTime(row.created_at),
    latestRun: latestRun === undefined ? null : { status: latestRun.status, updatedAt: toIsoDateTime(latestRun.updated_at) }
  });
}

function mapEvidence(row: EvidenceRow): EvidenceDetail | undefined {
  const locator = row.source_locator?.trim();
  if (!locator) return undefined;
  const fields = parseRecord(row.content);
  const sourcePath = locator.split('#', 1)[0];
  if (!sourcePath) return undefined;
  const identity = stableIdentity(sourcePath, fields, locator);
  if (identity === undefined || !identity.key || !identity.id) return undefined;
  const eventDate = isoDateOrNull(row.event_date ?? undefined);
  return {
    id: row.id,
    sourceType: row.source_type as EvidenceDetail['sourceType'],
    sourcePath,
    stableKey: identity.key,
    stableId: identity.id,
    citationLabel: `source=${sourcePath}, ${identity.key}=${identity.id}`,
    chunkId: row.id,
    capturedAt: eventDate === null ? toIsoDateTime(row.created_at) : `${eventDate}T00:00:00.000Z`,
    content: row.content
  };
}

function stableIdentity(sourcePath: string, fields: Readonly<Record<string, string>>, locator: string): Readonly<{ key: string; id: string }> | undefined {
  if (sourcePath.endsWith('/opportunities.tsv')) return identity('opportunity_id', fields.opportunityId ?? locatorId(locator));
  if (sourcePath.endsWith('/accounts.tsv')) return identity('account_id', fields.accountId ?? locatorId(locator));
  if (sourcePath.endsWith('/contacts.tsv')) return identity('contact_id', fields.contactId ?? locatorId(locator));
  if (sourcePath.includes('/gong_call_summaries.tsv') || sourcePath.includes('/transcripts/')) return identity('call_id', fields.callId ?? callIdFromPath(sourcePath) ?? locatorId(locator));
  if (sourcePath.endsWith('/pricing_notes.tsv')) return identity('pricing_note_id', fields.pricingNoteId ?? locatorId(locator));
  if (sourcePath.endsWith('/account_team_updates.tsv')) return identity('update_id', fields.updateId ?? locatorId(locator));
  if (sourcePath.endsWith('/deal_desk_policy.md')) return { key: 'policy_id', id: 'deal-desk-policy' };
  return identity('record_id', locatorId(locator));
}

function identity(key: string, id: string | undefined): Readonly<{ key: string; id: string }> | undefined {
  return id === undefined || id.trim().length === 0 ? undefined : { key, id: id.trim() };
}

function buildBrief(deal: DealListItem, fields: Readonly<Record<string, string>>, stakeholderRows: readonly EvidenceRow[], evidence: readonly EvidenceDetail[]): DealBriefView {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const opportunity = evidence.find((item) => item.sourcePath.endsWith('/opportunities.tsv'));
  const latestConversation = evidence.filter((item) => item.sourceType === 'gong_summary').sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0];
  const slack = evidence.filter((item) => item.sourceType === 'slack');
  const gapUpdate = slack.find(isExplicitUnresolvedUpdate);
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
    sourceEvidence: section('sourceEvidence', [`${evidence.length} authorized source records support this workspace. Citation controls open representative immutable record identifiers.`], [], representativeEvidence.map((item) => item.id)),
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
function isoDateOrNull(value: string | undefined): string | null { return value !== undefined && isoDateSchema.safeParse(value).success ? value : null; }
function dateInside(value: string | undefined): string | null {
  const candidate = value?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  return candidate !== undefined && isoDateSchema.safeParse(candidate).success ? candidate : null;
}
function currencyOrNull(value: string | undefined): string | null {
  const candidate = value?.trim().toUpperCase();
  return candidate !== undefined && /^[A-Z]{3}$/.test(candidate) ? candidate : null;
}
function isDefined<T>(value: T | undefined): value is T { return value !== undefined; }
function isExplicitUnresolvedUpdate(item: EvidenceDetail): boolean {
  const fields = parseRecord(item.content);
  if (fields.updateStatus !== undefined) return fields.updateStatus.trim().toLowerCase() === 'unresolved';
  const text = fields.updateText ?? '';
  if (/\b(?:is now|has now been|has been)\b[^.]*\b(?:confirmed|resolved|completed|approved|provided)\b/i.test(text)) return false;
  return [
    /\bhas not yet been confirmed\b/i,
    /\bno confirmed\b[^.]*\b(?:yet|incomplete)\b/i,
    /\bdoes not contain\b[^.]*\b(?:missing input|information gap)\b/i,
    /\btreat this as unresolved\b/i
  ].some((pattern) => pattern.test(text));
}
function riskLevel(value: string | undefined): DealListItem['riskLevel'] { return value === 'low' || value === 'medium' || value === 'high' ? value : 'unknown'; }
function confidenceForRisk(value: DealListItem['riskLevel']): number { return value === 'low' ? 0.82 : value === 'medium' ? 0.7 : value === 'high' ? 0.55 : 0.5; }
function toIsoDateTime(value: Date | string): string { return (value instanceof Date ? value : new Date(value)).toISOString(); }
function locatorId(locator: string | null): string | undefined { return locator?.split('#')[1]?.split('/')[0]; }
function callIdFromPath(path: string): string | undefined { return path.match(/(CALL-\d+)/)?.[1]; }
