import {
  type BriefSectionView,
  type DealBriefView,
  type DealListItem,
  type DealWorkspaceView,
  dealListItemSchema,
  dealWorkspaceViewSchema,
  type EvidenceDetail,
  type GeneratedDealOutputView,
  isoDateSchema,
  type RecommendedActionView,
  type ReviewWarningView,
  type SourceSnapshotView,
  type StakeholderView
} from '@slacato/contracts';
import type {
  AuthorizedDeal,
  Claim,
  DealBrief,
  DealEvidence,
  DealRunSummary,
  GeneratedDealOutput,
  LatestDealRun,
  ReviewWarning
} from '@slacato/core';
import { isExplicitBriefUncertainty, projectEvidenceDetail } from '@slacato/core';

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

type SectionId = keyof typeof sectionTitles;

type SourceSnapshotRenderingInput = Readonly<{
  deal: DealListItem;
  opportunityRecord: DealEvidence | undefined;
  stakeholderEvidence: readonly DealEvidence[];
  evidence: readonly EvidenceDetail[];
}>;

type GeneratedOutputRenderingInput = Readonly<{
  generatedOutput: GeneratedDealOutput | null;
  producingRun: LatestDealRun | undefined;
  evidence: readonly EvidenceDetail[];
}>;

type SourceBackedBriefView = Omit<DealBriefView, 'status'> & Readonly<{ status: 'source_backed' }>;
type GeneratedBriefView = Omit<DealBriefView, 'status'> & Readonly<{ status: 'generated' }>;

type AuthorizedWorkspaceEvidence = Readonly<{
  evidence: readonly EvidenceDetail[];
  opportunityRecord: DealEvidence | undefined;
  stakeholderEvidence: readonly DealEvidence[];
}>;

/** Input for rendering a full authorized deal workspace view from authorized query results. */
export type RenderDealWorkspaceInput = Readonly<{
  sessionVersion: string;
  target: AuthorizedDeal;
  latestRun: LatestDealRun | undefined;
  opportunityRows: readonly DealEvidence[];
  stakeholderRows: readonly DealEvidence[];
  supplementalRows: readonly DealEvidence[];
}>;

/** Maps an authorized deal query model into the public deal-list contract. */
export function mapAuthorizedDealToListItem(
  deal: AuthorizedDeal,
  latestRun: DealRunSummary | null = deal.latestRun
): DealListItem {
  const fields = parseColonDelimitedRecord(deal.recordContent ?? '');
  return dealListItemSchema.parse({
    opportunityId: deal.opportunityId,
    opportunityName: fields.opportunityName ?? deal.opportunityName,
    accountName: fields.accountName ?? deal.accountName,
    stage: fields.stage ?? 'Stage unavailable',
    owner: fields.owner ?? null,
    closeDate: parseIsoDate(fields.closeDate),
    amount: parseFiniteNumber(fields.acv),
    currency: normalizeCurrencyCode(fields.currency ?? fields.currencyIsoCode),
    probability: parseFiniteNumber(fields.probability),
    riskLevel: normalizeRiskLevel(fields.riskLevel),
    restricted: deal.restricted,
    createdAt: serializeDateTime(deal.createdAt),
    latestRun:
      latestRun === null
        ? null
        : { status: latestRun.status, updatedAt: serializeDateTime(latestRun.updatedAt) }
  });
}

/** Projects authorized repository evidence while excluding unstable provenance and invalid optional dates. */
function projectAuthorizedWorkspaceEvidence(
  opportunityRows: readonly DealEvidence[],
  stakeholderRows: readonly DealEvidence[],
  supplementalRows: readonly DealEvidence[]
): AuthorizedWorkspaceEvidence {
  const opportunityEvidence = opportunityRows
    .map(projectEvidenceDetail)
    .filter((item): item is EvidenceDetail => item !== undefined);
  const stakeholderEvidenceDetails = stakeholderRows
    .map(projectEvidenceDetail)
    .filter((item): item is EvidenceDetail => item !== undefined);
  const supplementalEvidence = supplementalRows
    .map(projectEvidenceDetail)
    .filter((item): item is EvidenceDetail => item !== undefined);
  const evidence = [...opportunityEvidence, ...stakeholderEvidenceDetails, ...supplementalEvidence];
  const includedEvidenceIds = new Set(evidence.map((item) => item.id));
  return {
    evidence,
    opportunityRecord: opportunityRows.find((row) => includedEvidenceIds.has(row.id)),
    stakeholderEvidence: stakeholderRows.filter((row) => includedEvidenceIds.has(row.id))
  };
}

/** Renders deterministic authorized records as a source snapshot rather than generated output. */
function renderSourceSnapshot(input: SourceSnapshotRenderingInput): SourceSnapshotView {
  return {
    type: 'source_snapshot',
    label: 'Source snapshot',
    evidenceOverview: renderSourceBackedDealBrief(
      input.deal,
      parseColonDelimitedRecord(input.opportunityRecord?.content ?? ''),
      input.stakeholderEvidence,
      input.evidence
    )
  };
}

/** Renders a generated draft or finalized artifact only with the run that produced it. */
function renderGeneratedOutput(
  input: GeneratedOutputRenderingInput
): GeneratedDealOutputView | null {
  if (input.generatedOutput === null || input.producingRun === undefined) return null;
  const brief = input.generatedOutput.brief;
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const claims = collectCanonicalBriefClaims(brief);
  if (!canonicalEvidenceIsAuthorized(brief, claims, evidenceById)) return null;
  return {
    type: 'generated_output',
    lifecycle: input.generatedOutput.lifecycle,
    producingRun: {
      id: input.producingRun.runId,
      status: input.producingRun.status,
      updatedAt: serializeDateTime(input.producingRun.updatedAt)
    },
    content: renderFinalizedDealBrief(brief, evidenceById, claims)
  };
}

/** Keeps the legacy brief field available while newer clients use the separate workspace representations. */
function legacyBriefForWorkspace(
  sourceSnapshot: SourceSnapshotView,
  generatedOutput: GeneratedDealOutputView | null
): DealBriefView {
  return generatedOutput?.content ?? sourceSnapshot.evidenceOverview;
}

/**
 * Renders a full authorized deal workspace view: projects authorized evidence, maps the deal
 * summary, then assembles the source snapshot, generated output, and legacy brief in the order
 * that the workspace response depends on.
 */
export function renderDealWorkspace(input: RenderDealWorkspaceInput): DealWorkspaceView {
  const workspaceEvidence = projectAuthorizedWorkspaceEvidence(
    input.opportunityRows,
    input.stakeholderRows,
    input.supplementalRows
  );
  const deal = mapAuthorizedDealToListItem(
    { ...input.target, recordContent: workspaceEvidence.opportunityRecord?.content ?? null },
    input.latestRun ?? null
  );
  const sourceSnapshot = renderSourceSnapshot({
    deal,
    opportunityRecord: workspaceEvidence.opportunityRecord,
    stakeholderEvidence: workspaceEvidence.stakeholderEvidence,
    evidence: workspaceEvidence.evidence
  });
  const generatedOutput = renderGeneratedOutput({
    generatedOutput: input.latestRun?.generatedOutput ?? null,
    producingRun: input.latestRun,
    evidence: workspaceEvidence.evidence
  });
  const brief = legacyBriefForWorkspace(sourceSnapshot, generatedOutput);

  return dealWorkspaceViewSchema.parse({
    sessionVersion: input.sessionVersion,
    deal,
    sourceSnapshot,
    generatedOutput,
    brief,
    evidence: workspaceEvidence.evidence
  });
}

/** Renders all nine canonical generated sections after proving every referenced evidence ID is authorized. */
function renderFinalizedDealBrief(
  brief: DealBrief,
  evidenceById: ReadonlyMap<string, EvidenceDetail>,
  claims: readonly Claim[]
): GeneratedBriefView {
  const claimsById = indexCanonicalClaimsById(claims);
  const stakeholders = brief.stakeholderMap.stakeholders.map((stakeholder): StakeholderView => {
    const citationIds = collectClaimEvidenceIds(stakeholder.claims);
    return {
      name: stakeholder.name,
      title: stakeholder.title ?? null,
      role: stakeholder.role,
      influence: stakeholder.influence,
      relationship: stakeholder.relationship,
      goals: [...stakeholder.goals],
      concerns: [...stakeholder.concerns],
      citationIds
    };
  });
  const actions = brief.recommendedNextActions.actions.map((action): RecommendedActionView => {
    const citationIds = collectClaimEvidenceIds(action.claims);
    return { action: action.action, audience: action.audience, owner: action.owner ?? null, priority: action.priority, dueDate: action.dueDate ?? null,
    rationale: action.rationale,
    citationIds,
    accountTeamUpdateImpact: referencesAccountTeamEvidence(citationIds, evidenceById) };
  });
  const warnings = brief.confidenceAndReviewWarnings.warnings
    .map((warning): ReviewWarningView | undefined => {
      const binding = resolveWarningEvidenceBinding(warning, claimsById);
      // Warning code, severity, and message are reviewer-editable metadata, so none establishes a
      // narrower-viewer warning. Only a cited canonical claim that independently states a review
      // concern survives, rendered with projection-owned severity and its immutable statement.
      if (binding === undefined) return undefined;
      return {
        severity: 'warning',
        message: binding.subject.statement,
        citationIds: binding.citationIds,
        accountTeamUpdateImpact: referencesAccountTeamEvidence(binding.citationIds, evidenceById)
      };
    })
    .filter((warning): warning is ReviewWarningView => warning !== undefined);

  const dealSnapshotCitationIds = collectClaimEvidenceIds(brief.dealSnapshot.claims ?? []);
  const executiveSummaryCitationIds = collectClaimEvidenceIds(brief.executiveSummary.claims ?? []);
  const buyerGoalsCitationIds = collectClaimEvidenceIds(
    brief.buyerGoalsAndBusinessDrivers.claims ?? []
  );
  const stakeholderCitationIds = uniqueEvidenceIds([
    ...collectClaimEvidenceIds(brief.stakeholderMap.claims ?? []),
    ...stakeholders.flatMap((stakeholder) => stakeholder.citationIds)
  ]);
  const negotiationCitationIds = collectClaimEvidenceIds(brief.negotiationState.claims ?? []);
  const actionCitationIds = uniqueEvidenceIds(actions.flatMap((action) => action.citationIds));
  const sourceEvidenceCitationIds = uniqueEvidenceIds([
    ...brief.sourceEvidence.evidence.map((item) => item.evidenceId),
    ...brief.sourceEvidence.evidence.flatMap((item) => collectClaimEvidenceIds(item.claims))
  ]);
  const warningCitationIds = uniqueEvidenceIds(warnings.flatMap((warning) => warning.citationIds));

  const sections = {
    dealSnapshot: createBriefSectionView(
      'dealSnapshot',
      [`${brief.dealSnapshot.accountName} — ${brief.dealSnapshot.opportunityName}`],
      [
        `Stage: ${brief.dealSnapshot.stage}`,
        ...(brief.dealSnapshot.closeDate === undefined
          ? []
          : [`Close date: ${brief.dealSnapshot.closeDate}`]),
        ...(brief.dealSnapshot.amount === undefined
          ? []
          : [
              `Amount: ${brief.dealSnapshot.amount}${brief.dealSnapshot.currency === undefined ? '' : ` ${brief.dealSnapshot.currency}`}`
            ]),
        ...(brief.dealSnapshot.owner === undefined ? [] : [`Owner: ${brief.dealSnapshot.owner}`])
      ],
      dealSnapshotCitationIds,
      referencesAccountTeamEvidence(dealSnapshotCitationIds, evidenceById)
    ),
    executiveSummary: createBriefSectionView(
      'executiveSummary',
      [brief.executiveSummary.narrative],
      [],
      executiveSummaryCitationIds,
      referencesAccountTeamEvidence(executiveSummaryCitationIds, evidenceById)
    ),
    buyerGoalsAndBusinessDrivers: createBriefSectionView(
      'buyerGoalsAndBusinessDrivers',
      [...brief.buyerGoalsAndBusinessDrivers.businessDrivers],
      [...brief.buyerGoalsAndBusinessDrivers.goals],
      buyerGoalsCitationIds,
      referencesAccountTeamEvidence(buyerGoalsCitationIds, evidenceById)
    ),
    stakeholderMap: createBriefSectionView(
      'stakeholderMap',
      [...(brief.stakeholderMap.coverageGaps ?? [])],
      stakeholders.map((stakeholder) => `${stakeholder.name} — ${stakeholder.role}`),
      stakeholderCitationIds,
      referencesAccountTeamEvidence(stakeholderCitationIds, evidenceById)
    ),
    negotiationState: createBriefSectionView(
      'negotiationState',
      [brief.negotiationState.currentState],
      [...(brief.negotiationState.leverage ?? []), ...brief.negotiationState.risks],
      negotiationCitationIds,
      referencesAccountTeamEvidence(negotiationCitationIds, evidenceById)
    ),
    recommendedNextActions: createBriefSectionView(
      'recommendedNextActions',
      actions.map((action) => action.rationale),
      actions.map((action) => action.action),
      actionCitationIds,
      actions.some((action) => action.accountTeamUpdateImpact)
    ),
    missingInformation: createBriefSectionView(
      'missingInformation',
      brief.missingInformation.items.map((item) => item.whyItMatters),
      brief.missingInformation.items.map((item) => item.question),
      [],
      false
    ),
    sourceEvidence: createBriefSectionView(
      'sourceEvidence',
      [
        `${brief.sourceEvidence.evidence.length} authorized evidence records are summarized by the generated output.`
      ],
      brief.sourceEvidence.evidence.map((item) => item.summary),
      sourceEvidenceCitationIds,
      referencesAccountTeamEvidence(sourceEvidenceCitationIds, evidenceById)
    ),
    confidenceAndReviewWarnings: createBriefSectionView(
      'confidenceAndReviewWarnings',
      [
        `Overall generated confidence is ${Math.round(brief.confidenceAndReviewWarnings.overallConfidence * 100)}%.`
      ],
      warnings.map((warning) => warning.message),
      warningCitationIds,
      warnings.some((warning) => warning.accountTeamUpdateImpact)
    )
  };
  return {
    status: 'generated',
    overallConfidence: brief.confidenceAndReviewWarnings.overallConfidence,
    sections,
    stakeholders,
    actions,
    warnings
  };
}

/** Collects every canonical claim that can contribute citations to a rendered view. */
function collectCanonicalBriefClaims(brief: DealBrief): readonly Claim[] {
  return [
    ...(brief.dealSnapshot.claims ?? []),
    ...(brief.executiveSummary.claims ?? []),
    ...(brief.buyerGoalsAndBusinessDrivers.claims ?? []),
    ...(brief.stakeholderMap.claims ?? []),
    ...brief.stakeholderMap.stakeholders.flatMap((stakeholder) => stakeholder.claims),
    ...(brief.negotiationState.claims ?? []),
    ...brief.recommendedNextActions.actions.flatMap((action) => action.claims),
    ...brief.sourceEvidence.evidence.flatMap((item) => item.claims)
  ];
}

/** Builds an unambiguous claim lookup for warning-to-evidence projection. */
function indexCanonicalClaimsById(claims: readonly Claim[]): ReadonlyMap<string, Claim> {
  const claimsById = new Map<string, Claim>();
  for (const claim of claims) {
    if (claimsById.has(claim.id))
      throw new Error(`Finalized brief contains duplicate claim ${claim.id}`);
    claimsById.set(claim.id, claim);
  }
  return claimsById;
}

/** Allows generated output only when every canonical citation and source summary is authorized. */
function canonicalEvidenceIsAuthorized(
  brief: DealBrief,
  claims: readonly Claim[],
  evidenceById: ReadonlyMap<string, EvidenceDetail>
): boolean {
  const referencedEvidenceIds = uniqueEvidenceIds([
    ...claims.flatMap((claim) => claim.citations.map((citation) => citation.evidenceId)),
    ...brief.sourceEvidence.evidence.map((item) => item.evidenceId)
  ]);
  return referencedEvidenceIds.every((evidenceId) => evidenceById.has(evidenceId));
}

const CANONICAL_REVIEW_CONCERN =
  /\b(?:absence|absent|missing|unknown|unconfirmed|unresolved|uncertain|uncertainty|unverified)\b|\bnot\s+(?:available|confirmed|known|resolved|verified)\b|\brequires?\s+(?:review|verification)\b|\binsufficient\s+(?:supported\s+)?evidence\b/iu;

type WarningEvidenceBinding = Readonly<{
  subject: Claim;
  citationIds: string[];
}>;

/** Resolves a warning to its narrowest cited canonical review concern and authorized evidence IDs.
 *
 * Validation legitimately keeps a warning about a claim it then discarded from the brief, so an
 * unresolvable reference is an unrenderable warning rather than a server fault: the caller drops it.
 * Every reference must resolve; arbitrary metadata bound to a harmless claim does not create a
 * warning, and only the independently reviewable subject contributes public citations. */
function resolveWarningEvidenceBinding(
  warning: ReviewWarning,
  claimsById: ReadonlyMap<string, Claim>
): WarningEvidenceBinding | undefined {
  const claims: Claim[] = [];
  for (const claimId of warning.claimIds) {
    const claim = claimsById.get(claimId);
    if (claim === undefined) return undefined;
    claims.push(claim);
  }
  const subject = claims.find(
    (claim) =>
      claim.citations.length > 0 &&
      (isExplicitBriefUncertainty(claim.statement) ||
        CANONICAL_REVIEW_CONCERN.test(claim.statement))
  );
  if (subject === undefined) return undefined;
  return { subject, citationIds: collectClaimEvidenceIds([subject]) };
}

/** Projects canonical claim citations onto their immutable evidence IDs. */
function collectClaimEvidenceIds(claims: readonly Claim[]): string[] {
  return uniqueEvidenceIds(
    claims.flatMap((claim) => claim.citations.map((citation) => citation.evidenceId))
  );
}

/** Deduplicates evidence IDs without changing their deterministic first-seen order. */
function uniqueEvidenceIds(evidenceIds: readonly string[]): string[] {
  return [...new Set(evidenceIds)];
}

/** Detects whether rendered evidence includes an authorized account-team update. */
function referencesAccountTeamEvidence(
  evidenceIds: readonly string[],
  evidenceById: ReadonlyMap<string, EvidenceDetail>
): boolean {
  return evidenceIds.some((evidenceId) => evidenceById.get(evidenceId)?.sourceType === 'slack');
}

/** Builds deterministic source cues from authorized records only; this is not generated output. */
function renderSourceBackedDealBrief(
  deal: DealListItem,
  fields: Readonly<Record<string, string>>,
  stakeholderEvidence: readonly DealEvidence[],
  evidence: readonly EvidenceDetail[]
): SourceBackedBriefView {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const opportunity = evidence.find((item) => item.sourcePath.endsWith('/opportunities.tsv'));
  const latestConversation = evidence
    .filter((item) => item.sourceType === 'gong_summary')
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0];
  const accountTeamUpdates = evidence.filter((item) => item.sourceType === 'slack');
  const unresolvedUpdate = accountTeamUpdates.find(isUnresolvedAccountTeamUpdate);
  const alignmentUpdate =
    accountTeamUpdates.find((item) => item.id !== unresolvedUpdate?.id) ?? accountTeamUpdates[0];
  const conversationFields = parseColonDelimitedRecord(latestConversation?.content ?? '');
  const unresolvedUpdateFields = parseColonDelimitedRecord(unresolvedUpdate?.content ?? '');
  const stakeholders = stakeholderEvidence.map(mapSourceBackedStakeholder);
  const actions = buildSourceBackedActions(
    deal,
    fields,
    opportunity,
    latestConversation,
    unresolvedUpdate,
    unresolvedUpdateFields
  );
  const warnings = buildSourceBackedWarnings(
    deal,
    opportunity,
    unresolvedUpdate,
    unresolvedUpdateFields
  );
  const opportunityEvidenceIds = evidenceIdsForItem(opportunity);
  const conversationEvidenceIds = evidenceIdsForItem(latestConversation);
  const unresolvedUpdateEvidenceIds = evidenceIdsForItem(unresolvedUpdate);
  const stakeholderEvidenceIds = stakeholders.flatMap((stakeholder) => stakeholder.citationIds);
  const representativeEvidence = evidence.slice(0, 12);

  const sections = {
    dealSnapshot: createBriefSectionView(
      'dealSnapshot',
      [
        `${deal.accountName} is at ${deal.stage} with ${deal.probability === null ? 'an unrecorded' : `${deal.probability}%`} probability.`,
        deal.closeDate === null
          ? 'No close date is recorded.'
          : `The recorded close date is ${deal.closeDate}.`
      ],
      [fields.type, fields.forecastCategory].filter(isNonEmptyString),
      opportunityEvidenceIds
    ),
    executiveSummary: createBriefSectionView(
      'executiveSummary',
      [
        conversationFields.summary ??
          `The authorized source record places this opportunity at ${deal.stage}.`,
        alignmentUpdate === undefined
          ? 'No authorized account-team update is available.'
          : (parseColonDelimitedRecord(alignmentUpdate.content).updateText ??
            alignmentUpdate.content)
      ],
      [],
      [...conversationEvidenceIds, ...evidenceIdsForItem(alignmentUpdate)],
      alignmentUpdate !== undefined
    ),
    buyerGoalsAndBusinessDrivers: createBriefSectionView(
      'buyerGoalsAndBusinessDrivers',
      [
        isNonEmptyString(fields.primaryCompetitor)
          ? `The authorized opportunity record names ${fields.primaryCompetitor} as the primary competitive alternative shaping buyer priorities.`
          : 'No authorized opportunity record identifies a competitive alternative shaping buyer priorities.'
      ],
      splitCommaSeparatedValues(conversationFields.keyPoints),
      uniqueEvidenceIds([...conversationEvidenceIds, ...opportunityEvidenceIds])
    ),
    stakeholderMap: createBriefSectionView(
      'stakeholderMap',
      [
        stakeholders.length === 0
          ? 'No authorized stakeholder records are available.'
          : `${stakeholders.length} authorized stakeholder records are available for review.`
      ],
      stakeholders.map((stakeholder) => `${stakeholder.name} — ${stakeholder.role}`),
      stakeholderEvidenceIds
    ),
    negotiationState: createBriefSectionView(
      'negotiationState',
      [
        conversationFields.risks ?? `${deal.riskLevel} risk is recorded for the opportunity.`,
        unresolvedUpdateFields.updateText ?? 'No later authorized account-team change is recorded.'
      ],
      [fields.nextStep].filter(isNonEmptyString),
      [...conversationEvidenceIds, ...unresolvedUpdateEvidenceIds],
      unresolvedUpdate !== undefined
    ),
    recommendedNextActions: createBriefSectionView(
      'recommendedNextActions',
      ['These are deterministic source cues, not generated recommendations or a run output.'],
      actions.map((action) => action.action),
      actions.flatMap((action) => action.citationIds),
      actions.some((action) => action.accountTeamUpdateImpact)
    ),
    missingInformation: createBriefSectionView(
      'missingInformation',
      [
        unresolvedUpdateFields.updateText ??
          'No explicit authorized account-team information gap is recorded.'
      ],
      unresolvedUpdate === undefined ? [] : ['Confirm this account-team gap with the named owner.'],
      unresolvedUpdateEvidenceIds,
      unresolvedUpdate !== undefined
    ),
    sourceEvidence: createBriefSectionView(
      'sourceEvidence',
      [
        `${evidence.length} authorized source records support this workspace. Citation controls open representative immutable record identifiers.`
      ],
      [],
      representativeEvidence.map((item) => item.id)
    ),
    confidenceAndReviewWarnings: createBriefSectionView(
      'confidenceAndReviewWarnings',
      [
        `The deterministic source-cue confidence indicator is ${Math.round(sourceBackedConfidenceForRisk(deal.riskLevel) * 100)}%.`
      ],
      warnings.map((warning) => warning.message),
      warnings.flatMap((warning) => warning.citationIds),
      warnings.some((warning) => warning.accountTeamUpdateImpact)
    )
  };

  for (const citationId of Object.values(sections).flatMap((section) => section.citationIds)) {
    if (!evidenceById.has(citationId))
      throw new Error(`Brief citation ${citationId} is not authorized for this workspace`);
  }
  return {
    status: 'source_backed',
    overallConfidence: sourceBackedConfidenceForRisk(deal.riskLevel),
    sections,
    stakeholders,
    actions,
    warnings
  };
}

/** Creates a deterministic section view with filtered text and stable citation order. */
function createBriefSectionView(
  id: SectionId,
  paragraphs: readonly string[],
  items: readonly string[],
  citationIds: readonly string[],
  accountTeamUpdateImpact = false
): BriefSectionView {
  return {
    title: sectionTitles[id],
    paragraphs: paragraphs.filter(isNonEmptyString),
    items: items.filter(isNonEmptyString),
    citationIds: uniqueEvidenceIds(citationIds),
    accountTeamUpdateImpact
  };
}

/** Maps an authorized contact record into the source-backed stakeholder view. */
function mapSourceBackedStakeholder(evidence: DealEvidence): StakeholderView {
  const fields = parseColonDelimitedRecord(evidence.content);
  return {
    name: fields.fullName ?? 'Unnamed stakeholder',
    title: fields.title ?? null,
    role: fields.roleInDeal ?? 'Role not recorded',
    influence: fields.influenceLevel ?? 'unknown',
    relationship: (fields.sentiment ?? 'unknown').replaceAll('_', ' '),
    goals: [],
    concerns: fields.notes === undefined ? [] : [fields.notes],
    citationIds: [evidence.id]
  };
}

/** Builds source-backed actions from authorized opportunity, conversation, and account-team records. */
function buildSourceBackedActions(
  deal: DealListItem,
  fields: Readonly<Record<string, string>>,
  opportunity: EvidenceDetail | undefined,
  conversation: EvidenceDetail | undefined,
  unresolvedUpdate: EvidenceDetail | undefined,
  unresolvedUpdateFields: Readonly<Record<string, string>>
): RecommendedActionView[] {
  const actions: RecommendedActionView[] = [];
  if (fields.nextStep !== undefined)
    actions.push({ action: fields.nextStep, audience: 'internal', owner: deal.owner, priority: deal.riskLevel === 'high' ? 'critical' : 'high', dueDate: extractIsoDate(fields.nextStep),
    rationale: 'This is the next step recorded in the authorized opportunity source.',
    citationIds: evidenceIdsForItem(opportunity),
    accountTeamUpdateImpact: false });
  if (unresolvedUpdate !== undefined)
    actions.push({ action: 'Confirm the latest account-team information gap before finalizing the packet.', audience: 'internal', owner: deal.owner, priority: 'high', dueDate: deal.closeDate,
    rationale: unresolvedUpdateFields.updateText ?? unresolvedUpdate.content,
    citationIds: [unresolvedUpdate.id],
    accountTeamUpdateImpact: true });
  else if (conversation !== undefined) {
    const conversationFields = parseColonDelimitedRecord(conversation.content);
    actions.push({ action: conversationFields.nextSteps ?? 'Confirm the next negotiation step with the account team.', audience: 'internal', owner: deal.owner, priority: 'medium', dueDate: extractIsoDate(conversationFields.nextSteps),
    rationale: 'This action is grounded in the latest authorized conversation summary.',
    citationIds: [conversation.id],
    accountTeamUpdateImpact: false });
  }
  return actions;
}

/** Builds source-backed review warnings from authorized risk and account-team records. */
function buildSourceBackedWarnings(
  deal: DealListItem,
  opportunity: EvidenceDetail | undefined,
  unresolvedUpdate: EvidenceDetail | undefined,
  unresolvedUpdateFields: Readonly<Record<string, string>>
): ReviewWarningView[] {
  const warnings: ReviewWarningView[] = [
    {
      severity:
        deal.riskLevel === 'high' ? 'critical' : deal.riskLevel === 'medium' ? 'warning' : 'info',
      message: `${deal.riskLevel[0]?.toUpperCase()}${deal.riskLevel.slice(1)} opportunity risk is recorded; seller review remains required.`,
      citationIds: evidenceIdsForItem(opportunity),
      accountTeamUpdateImpact: false
    }
  ];
  if (unresolvedUpdate !== undefined)
    warnings.push({
      severity: 'warning',
      message: unresolvedUpdateFields.updateText ?? unresolvedUpdate.content,
      citationIds: [unresolvedUpdate.id],
      accountTeamUpdateImpact: true
    });
  return warnings;
}

/** Parses the fixture record format into named values without exposing storage naming conventions. */
function parseColonDelimitedRecord(content: string): Readonly<Record<string, string>> {
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

/** Returns the evidence ID for an optional authorized evidence item. */
function evidenceIdsForItem(item: EvidenceDetail | undefined): string[] {
  return item === undefined ? [] : [item.id];
}

/** Narrows filtered text to non-empty strings. */
function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

/** Splits a comma-delimited fixture field into normalized non-empty values. */
function splitCommaSeparatedValues(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

/** Parses a finite numeric fixture field or returns null when absent or invalid. */
function parseFiniteNumber(value: string | undefined): number | null {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Accepts a calendar-valid ISO date or returns null. */
function parseIsoDate(value: string | undefined): string | null {
  return value !== undefined && isoDateSchema.safeParse(value).success ? value : null;
}

/** Extracts the first calendar-valid ISO date embedded in free text. */
function extractIsoDate(value: string | undefined): string | null {
  const candidate = value?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  return candidate !== undefined && isoDateSchema.safeParse(candidate).success ? candidate : null;
}

/** Normalizes a valid three-letter currency code or returns null. */
function normalizeCurrencyCode(value: string | undefined): string | null {
  const candidate = value?.trim().toUpperCase();
  return candidate !== undefined && /^[A-Z]{3}$/.test(candidate) ? candidate : null;
}

/** Detects an explicit unresolved account-team update without reviving resolved prose. */
function isUnresolvedAccountTeamUpdate(item: EvidenceDetail): boolean {
  const fields = parseColonDelimitedRecord(item.content);
  if (fields.updateStatus !== undefined)
    return fields.updateStatus.trim().toLowerCase() === 'unresolved';
  const text = fields.updateText ?? '';
  if (
    /\b(?:is now|has now been|has been)\b[^.]*\b(?:confirmed|resolved|completed|approved|provided)\b/i.test(
      text
    )
  )
    return false;
  return [
    /\bhas not yet been confirmed\b/i,
    /\bno confirmed\b[^.]*\b(?:yet|incomplete)\b/i,
    /\bdoes not contain\b[^.]*\b(?:missing input|information gap)\b/i,
    /\b(?:still\s+)?lack(?:s|ing)?\b/i,
    /\bstill\s+need\b/i,
    /\bremains?\s+(?:absent|unknown|unconfirmed|unresolved|unaddressed|undocumented)\b/i,
    /\btreat this as unresolved\b/i
  ].some((pattern) => pattern.test(text));
}

/** Normalizes the source risk label into the public risk-level contract. */
function normalizeRiskLevel(value: string | undefined): DealListItem['riskLevel'] {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'unknown';
}

/** Derives the deterministic confidence used only by the source-backed fallback. */
function sourceBackedConfidenceForRisk(value: DealListItem['riskLevel']): number {
  return value === 'low' ? 0.82 : value === 'medium' ? 0.7 : value === 'high' ? 0.55 : 0.5;
}

/** Serializes database date values as an ISO timestamp. */
function serializeDateTime(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
