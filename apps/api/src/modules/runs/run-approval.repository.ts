import {
  approvalBriefPayloadSchema,
  approvalStructuredDiffSchema,
  approvalDetailResponseSchema,
  approvalInboxResponseSchema,
  runDetailResponseSchema,
  runListResponseSchema,
  runStatusSchema,
  type ApprovalAuthority,
  type ApprovalBriefPayload,
  type ApprovalDecisionView,
  type ApprovalDetailResponse,
  type ApprovalInboxEntry,
  type ApprovalInboxResponse,
  type RunDetailResponse,
  type RunListResponse,
  type RunStatus
} from '@slacato/contracts';
import { CANONICAL_FIXTURE_COMMIT } from '@slacato/core';
import type { DatabaseClient } from '@slacato/infrastructure';

export const RUN_APPROVAL_QUERIES = Symbol('RUN_APPROVAL_QUERIES');

export interface RunApprovalQueryRepository {
  listRuns(actorId: string, sessionVersion: string): Promise<RunListResponse>;
  getRun(actorId: string, sessionVersion: string, runId: string): Promise<RunDetailResponse | undefined>;
  listApprovals(actorId: string, sessionVersion: string): Promise<ApprovalInboxResponse>;
  getApproval(actorId: string, sessionVersion: string, subjectId: string): Promise<ApprovalDetailResponse | undefined>;
}

type RunRow = Readonly<{
  run_id: string; opportunity_id: string; opportunity_name: string; account_name: string; initiated_by: string;
  status: string; version: number; created_at: Date | string; updated_at: Date | string;
}>;
type EventRow = Readonly<{ id: string; sequence: number; type: string; payload: unknown; created_at: Date | string }>;
type ApprovalRow = Readonly<{
  approval_subject_id: string; run_id: string; run_version: number; run_status: string; subject_hash: string;
  opportunity_id: string; opportunity_name: string; account_name: string; entry_id: string; category: string;
  eligible_authorities: unknown; available_authority: string; subject_created_at: Date | string; run_updated_at: Date | string;
  superseded_by_subject_id: string | null;
  required_count: number; completed_count: number; decision_action: string | null; decision_authority: string | null;
  decision_rationale: string | null; decision_diff: unknown; decision_created_at: Date | string | null; decision_actor_name: string | null;
}>;
type ApprovalSubjectRow = Readonly<{
  approval_subject_id: string; run_id: string; run_version: number; run_status: string; subject_hash: string; payload: unknown;
  opportunity_id: string; opportunity_name: string; account_name: string; created_at: Date | string; superseded_by_subject_id: string | null;
}>;
type ApprovalEntryRow = Readonly<{ entry_id: string; category: string; eligible_authorities: unknown; depends_on: unknown }>;
type DecisionRow = Readonly<{ action: string; authority: string; rationale: string | null; diff: unknown; created_at: Date | string; actor_name: string }>;

const sectionNames = [
  'Deal Snapshot', 'Executive Summary', 'Buyer Goals and Business Drivers', 'Stakeholder Map', 'Negotiation State',
  'Recommended Next Actions', 'Missing Information', 'Source Evidence', 'Confidence and Review Warnings'
] as const;
const specialistNames = ['conversation', 'stakeholder', 'commercial'] as const;
const terminalStatuses: readonly RunStatus[] = ['completed', 'rejected', 'failed', 'cancelled'];

/** Reads run and approval views while independently enforcing the actor's evidence visibility. */
export class PostgresRunApprovalQueryRepository implements RunApprovalQueryRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async listRuns(actorId: string, sessionVersion: string): Promise<RunListResponse> {
    const rows = await this.database.sql<RunRow[]>`
      select run.id run_id, opportunity.id opportunity_id, opportunity.name opportunity_name,
        account.name account_name, requester.display_name initiated_by, run.status, run.version,
        run.created_at, run.updated_at
      from runs run
      join opportunities opportunity on opportunity.id = run.opportunity_id
      join accounts account on account.id = opportunity.account_id
      join personas requester on requester.id = run.requested_by
      where exists (
        select 1 from permission_grants permission
        where permission.persona_id = ${actorId} and permission.account_id = opportunity.account_id
          and permission.can_read and permission.source_commit = ${CANONICAL_FIXTURE_COMMIT}
          and (not opportunity.restricted or permission.can_read_restricted)
      ) or exists (
        select 1 from approval_subjects subject
        join approval_requirement_entries entry on entry.approval_subject_id = subject.id
        join approval_authority_grants authority on authority.persona_id = ${actorId}
          and authority.account_id = opportunity.account_id
          and authority.source_commit = ${CANONICAL_FIXTURE_COMMIT}
          and authority.authority in (select jsonb_array_elements_text(entry.eligible_authorities))
        where subject.run_id = run.id
      )
      order by run.updated_at desc, run.id desc limit 1000`;
    return runListResponseSchema.parse({ sessionVersion, runs: rows.map(mapRunListRow) });
  }

  public async getRun(actorId: string, sessionVersion: string, runId: string): Promise<RunDetailResponse | undefined> {
    const row = (await this.database.sql<RunRow[]>`
      select run.id run_id, opportunity.id opportunity_id, opportunity.name opportunity_name,
        account.name account_name, requester.display_name initiated_by, run.status, run.version,
        run.created_at, run.updated_at
      from runs run
      join opportunities opportunity on opportunity.id = run.opportunity_id
      join accounts account on account.id = opportunity.account_id
      join personas requester on requester.id = run.requested_by
      where run.id = ${runId} and (
        exists (
          select 1 from permission_grants permission
          where permission.persona_id = ${actorId} and permission.account_id = opportunity.account_id
            and permission.can_read and permission.source_commit = ${CANONICAL_FIXTURE_COMMIT}
            and (not opportunity.restricted or permission.can_read_restricted)
        ) or exists (
          select 1 from approval_subjects subject
          join approval_requirement_entries entry on entry.approval_subject_id = subject.id
          join approval_authority_grants authority on authority.persona_id = ${actorId}
            and authority.account_id = opportunity.account_id
            and authority.source_commit = ${CANONICAL_FIXTURE_COMMIT}
            and authority.authority in (select jsonb_array_elements_text(entry.eligible_authorities))
          where subject.run_id = run.id
        )
      ) limit 1`)[0];
    if (row === undefined) return undefined;

    const [events, specialistRows, retrievalRows, validationRows, strategyRows] = await Promise.all([
      this.database.sql<EventRow[]>`select id, sequence, type, payload, created_at from run_events where run_id = ${runId} order by sequence desc limit 200`,
      this.database.sql<{ step: string; status: string | null }[]>`select distinct on (step) step, payload->>'status' status from workflow_checkpoints where run_id = ${runId} and step like 'specialist:%' order by step, created_at desc, id desc`,
      this.database.sql<{ evidence_count: number | null }[]>`select max((payload->>'evidenceCount')::integer) evidence_count from trace_spans where run_id = ${runId} and kind = 'evidence_retrieval'`,
      this.database.sql<{ retry_count: number | null }[]>`select coalesce(sum(greatest(validation_attempts - 1, 0)), 0)::integer retry_count from generation_attempts where run_id = ${runId}`,
      this.database.sql<{ present: boolean }[]>`select exists(
        select 1 from workflow_checkpoints where run_id = ${runId} and step like 'validation:%' and payload->>'status' = 'completed'
        union all select 1 from approval_subjects where run_id = ${runId}
      ) present`
    ]);
    const orderedEvents = [...events].reverse();
    const status = runStatusSchema.parse(row.status);
    const watermark = orderedEvents.at(-1);
    const specialistStatus = new Map(specialistRows.map((item) => [item.step.slice('specialist:'.length), item.status]));
    const fallback = specialistDefault(status);
    return runDetailResponseSchema.parse({
      sessionVersion,
      runId: row.run_id,
      opportunityId: row.opportunity_id,
      opportunityName: row.opportunity_name,
      accountName: row.account_name,
      initiatedBy: row.initiated_by,
      status,
      version: row.version,
      watermark: watermark?.id ?? null,
      watermarkSequence: watermark?.sequence ?? 0,
      terminal: terminalStatuses.includes(status),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      progress: {
        phase: status,
        retrievalCount: retrievalRows[0]?.evidence_count ?? 0,
        validationRetries: validationRows[0]?.retry_count ?? 0,
        specialists: specialistNames.map((name) => ({ name, status: specialistStatusValue(specialistStatus.get(name) ?? undefined, fallback) })),
        completedSections: strategyRows[0]?.present === true ? sectionNames : [],
        timeline: orderedEvents.map((event) => ({
          sequence: event.sequence, eventId: event.id, phase: phaseForEvent(event, status),
          label: labelForEvent(event.type), at: iso(event.created_at)
        }))
      }
    });
  }

  public async listApprovals(actorId: string, sessionVersion: string): Promise<ApprovalInboxResponse> {
    const rows = await this.database.sql<ApprovalRow[]>`
      select subject.id approval_subject_id, run.id run_id, run.version run_version, run.status run_status,
        subject.subject_hash, opportunity.id opportunity_id, opportunity.name opportunity_name, account.name account_name,
        entry.id entry_id, entry.category, entry.eligible_authorities, available.authority available_authority,
        subject.created_at subject_created_at, run.updated_at run_updated_at, subject.superseded_by_subject_id,
        (select count(*)::integer from approval_requirement_entries required where required.approval_subject_id = subject.id) required_count,
        (select count(*)::integer from approval_decisions completed where completed.approval_subject_id = subject.id) completed_count,
        decision.action decision_action, decision.authority decision_authority, decision.rationale decision_rationale,
        decision.diff decision_diff, decision.created_at decision_created_at, decision_actor.display_name decision_actor_name
      from approval_subjects subject
      join runs run on run.id = subject.run_id
      join opportunities opportunity on opportunity.id = run.opportunity_id
      join accounts account on account.id = opportunity.account_id
      join approval_requirement_entries entry on entry.approval_subject_id = subject.id
      join lateral (
        select authority.authority from approval_authority_grants authority
        where authority.persona_id = ${actorId} and authority.account_id = account.id
          and authority.source_commit = ${CANONICAL_FIXTURE_COMMIT}
          and authority.authority in (select jsonb_array_elements_text(entry.eligible_authorities))
        order by authority.authority limit 1
      ) available on true
      left join approval_decisions decision on decision.approval_subject_id = subject.id and decision.entry_id = entry.id
      left join personas decision_actor on decision_actor.id = decision.actor_id
      order by (decision.id is null and run.status = 'awaiting_approval' and subject.superseded_by_subject_id is null) desc,
        subject.created_at, subject.id, entry.ordinal`;
    const pairs = rows.map((row) => ({ row, entry: mapApprovalInboxEntry(row) }));
    return approvalInboxResponseSchema.parse({
      sessionVersion,
      pending: pairs.filter(({ row }) =>
        row.decision_action === null && row.run_status === 'awaiting_approval' && row.superseded_by_subject_id === null
      ).map(({ entry }) => entry),
      history: pairs.filter(({ row }) => row.decision_action !== null).map(({ entry }) => entry)
    });
  }

  /** Returns an approval view whose persisted payload is projected to evidence the actor may read. */
  public async getApproval(actorId: string, sessionVersion: string, subjectId: string): Promise<ApprovalDetailResponse | undefined> {
    const subject = (await this.database.sql<ApprovalSubjectRow[]>`
      select subject.id approval_subject_id, run.id run_id, run.version run_version, run.status run_status,
        subject.subject_hash, subject.payload, opportunity.id opportunity_id, opportunity.name opportunity_name,
        account.name account_name, subject.created_at, subject.superseded_by_subject_id
      from approval_subjects subject
      join runs run on run.id = subject.run_id
      join opportunities opportunity on opportunity.id = run.opportunity_id
      join accounts account on account.id = opportunity.account_id
      where subject.id = ${subjectId}
        and exists (
          select 1 from approval_requirement_entries requirement
          join approval_authority_grants authority on authority.persona_id = ${actorId} and authority.account_id = account.id
            and authority.source_commit = ${CANONICAL_FIXTURE_COMMIT}
          where requirement.approval_subject_id = subject.id
            and authority.authority in (select jsonb_array_elements_text(requirement.eligible_authorities))
        ) limit 1`)[0];
    if (subject === undefined) return undefined;

    const persistedPayload = approvalBriefPayloadSchema.safeParse(subject.payload);
    if (!persistedPayload.success) return undefined;
    const payloadEvidenceIds = persistedPayload.data.sourceEvidence.evidence.map((evidence) => evidence.evidenceId);
    const [entryRows, authorityRows, decisionRows, decidedEntryRows, readableDealRows, readableEvidenceRows] = await Promise.all([
      this.database.sql<ApprovalEntryRow[]>`select id entry_id, category, eligible_authorities, depends_on from approval_requirement_entries where approval_subject_id = ${subjectId} order by ordinal`,
      this.database.sql<{ authority: string }[]>`select authority from approval_authority_grants
        where persona_id = ${actorId} and source_commit = ${CANONICAL_FIXTURE_COMMIT}
          and account_id = (select opportunity.account_id from runs run join opportunities opportunity on opportunity.id = run.opportunity_id where run.id = ${subject.run_id})`,
      this.database.sql<DecisionRow[]>`select decision.action, decision.authority, decision.rationale, decision.diff, decision.created_at, persona.display_name actor_name from approval_decisions decision join personas persona on persona.id = decision.actor_id where decision.approval_subject_id = ${subjectId} order by decision.created_at, decision.id`,
      this.database.sql<{ entry_id: string }[]>`select entry_id from approval_decisions where approval_subject_id = ${subjectId}`,
      this.database.sql<{ source_type: string }[]>`select distinct permission.source_type
        from permission_grants permission join opportunities opportunity on opportunity.account_id = permission.account_id
        where permission.persona_id = ${actorId} and opportunity.id = ${subject.opportunity_id}
          and permission.source_commit = ${CANONICAL_FIXTURE_COMMIT} and permission.can_read
          and (not opportunity.restricted or permission.can_read_restricted)`,
      this.database.sql<{ id: string }[]>`select evidence.id
        from evidence_versions evidence
        join opportunities opportunity on opportunity.id = evidence.opportunity_id
        where evidence.id = any(${payloadEvidenceIds}::text[])
          and evidence.opportunity_id = ${subject.opportunity_id}
          and evidence.account_id = opportunity.account_id
          and evidence.source_locator is not null and btrim(evidence.source_locator) <> ''
          and exists (
            select 1 from permission_grants source_grant
            where source_grant.persona_id = ${actorId}
              and source_grant.account_id = evidence.account_id
              and source_grant.source_type = evidence.source_type
              and source_grant.can_read = true
              and source_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
              and (opportunity.restricted = false or source_grant.can_read_restricted = true)
              and (
                evidence.sensitivity <> 'restricted'
                or (evidence.source_type = 'pricing' and source_grant.sensitive_pricing = true)
                or (evidence.source_type <> 'pricing' and source_grant.can_read_restricted = true)
              )
          )
        order by evidence.id`
    ]);
    const actorAuthorities = new Set(authorityRows.map((row) => approvalAuthority(row.authority)));
    const decisions = decisionRows.map(mapDecision);
    const decidedEntries = new Set(decidedEntryRows.map((row) => row.entry_id));
    const readableEvidenceIds = new Set(readableEvidenceRows.map(({ id }) => id));
    const visiblePayload = projectApprovalPayloadForReadableEvidence(persistedPayload.data, readableEvidenceIds);
    if (visiblePayload === undefined) return undefined;
    return approvalDetailResponseSchema.parse({
      sessionVersion,
      approvalSubjectId: subject.approval_subject_id,
      runId: subject.run_id,
      runVersion: subject.run_version,
      subjectHash: subject.subject_hash,
      opportunityId: subject.opportunity_id,
      opportunityName: subject.opportunity_name,
      accountName: subject.account_name,
      status: subject.run_status,
      payload: visiblePayload,
      entries: entryRows.map((entry) => {
        const required = authorities(entry.eligible_authorities);
        return {
          entryId: entry.entry_id,
          category: entry.category,
          requiredAuthorities: required,
          availableAuthority: required.find((authority) => actorAuthorities.has(authority)) ?? null,
          dependsOn: strings(entry.depends_on),
          decided: decidedEntries.has(entry.entry_id)
        };
      }),
      decisions,
      quorum: { completed: decisions.length, required: entryRows.length },
      capabilities: {
        canReadDeal: readableDealRows.length > 0,
        evidenceIds: visiblePayload.sourceEvidence.evidence.map((evidence) => evidence.evidenceId)
      },
      createdAt: iso(subject.created_at),
      supersededBySubjectId: subject.superseded_by_subject_id
    });
  }
}

const REDACTED_APPROVAL_TEXT = 'Restricted pending evidence access';

/**
 * Produces a schema-valid brief that replaces generated content unless its own claims are entirely readable.
 */
function projectApprovalPayloadForReadableEvidence(
  payload: ApprovalBriefPayload,
  readableEvidenceIds: ReadonlySet<string>
): ApprovalBriefPayload | undefined {
  const dealSnapshotClaims = retainClaimsCitingReadableEvidence(payload.dealSnapshot.claims, readableEvidenceIds);
  const executiveSummaryClaims = retainClaimsCitingReadableEvidence(payload.executiveSummary.claims, readableEvidenceIds);
  const buyerClaims = retainClaimsCitingReadableEvidence(payload.buyerGoalsAndBusinessDrivers.claims, readableEvidenceIds);
  const stakeholderMapClaims = retainClaimsCitingReadableEvidence(payload.stakeholderMap.claims, readableEvidenceIds);
  const negotiationClaims = retainClaimsCitingReadableEvidence(payload.negotiationState.claims, readableEvidenceIds);

  const projectedWithoutWarnings = approvalBriefPayloadSchema.safeParse({
    dealSnapshot: dealSnapshotClaims.complete
      ? { ...payload.dealSnapshot, claims: dealSnapshotClaims.claims }
      : {
          accountName: REDACTED_APPROVAL_TEXT,
          opportunityName: REDACTED_APPROVAL_TEXT,
          stage: REDACTED_APPROVAL_TEXT,
          claims: dealSnapshotClaims.claims
        },
    executiveSummary: executiveSummaryClaims.complete
      ? { ...payload.executiveSummary, claims: executiveSummaryClaims.claims }
      : { narrative: REDACTED_APPROVAL_TEXT, claims: executiveSummaryClaims.claims },
    buyerGoalsAndBusinessDrivers: buyerClaims.complete
      ? { ...payload.buyerGoalsAndBusinessDrivers, claims: buyerClaims.claims }
      : { goals: [], businessDrivers: [], claims: buyerClaims.claims },
    stakeholderMap: {
      stakeholders: payload.stakeholderMap.stakeholders.flatMap((stakeholder) => {
        const claims = retainClaimsCitingReadableEvidence(stakeholder.claims, readableEvidenceIds);
        return claims.complete ? [{ ...stakeholder, claims: claims.claims }] : [];
      }),
      ...(stakeholderMapClaims.complete && payload.stakeholderMap.coverageGaps !== undefined
        ? { coverageGaps: payload.stakeholderMap.coverageGaps }
        : {}),
      claims: stakeholderMapClaims.claims
    },
    negotiationState: negotiationClaims.complete
      ? { ...payload.negotiationState, claims: negotiationClaims.claims }
      : { currentState: REDACTED_APPROVAL_TEXT, risks: [], claims: negotiationClaims.claims },
    recommendedNextActions: {
      actions: payload.recommendedNextActions.actions.flatMap((action) => {
        const claims = retainClaimsCitingReadableEvidence(action.claims, readableEvidenceIds);
        return claims.complete ? [{ ...action, claims: claims.claims }] : [];
      })
    },
    missingInformation: { items: [] },
    sourceEvidence: {
      evidence: payload.sourceEvidence.evidence
        .filter((evidence) => readableEvidenceIds.has(evidence.evidenceId))
        .map((evidence) => ({
          ...evidence,
          claims: retainClaimsCitingReadableEvidence(evidence.claims, readableEvidenceIds).claims
        }))
    },
    confidenceAndReviewWarnings: { overallConfidence: 0, warnings: [] }
  });
  if (!projectedWithoutWarnings.success) return undefined;

  const retainedClaimIds = new Set<string>();
  collectProjectedClaimIds(projectedWithoutWarnings.data, retainedClaimIds);
  const projectedPayload = approvalBriefPayloadSchema.safeParse({
    ...projectedWithoutWarnings.data,
    confidenceAndReviewWarnings: {
      overallConfidence: 0,
      warnings: payload.confidenceAndReviewWarnings.warnings.filter((warning) =>
        warning.claimIds.length > 0 && warning.claimIds.every((claimId) => retainedClaimIds.has(claimId))
      )
    }
  });
  return projectedPayload.success ? projectedPayload.data : undefined;
}

/** Retains a claim only when it has citations and every citation names readable evidence. */
function retainClaimsCitingReadableEvidence(
  claims: readonly unknown[] | undefined,
  readableEvidenceIds: ReadonlySet<string>
): Readonly<{ claims: unknown[]; complete: boolean }> {
  const originalClaims = claims ?? [];
  const readableClaims = originalClaims.filter((claim) => claimCitesOnlyReadableEvidence(claim, readableEvidenceIds));
  return {
    claims: readableClaims,
    complete: originalClaims.length > 0 && readableClaims.length === originalClaims.length
  };
}

/** Collects claim identifiers that remain present in the validated projected payload. */
function collectProjectedClaimIds(value: unknown, retainedClaimIds: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProjectedClaimIds(item, retainedClaimIds);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'claims' && Array.isArray(nestedValue)) {
      for (const claim of nestedValue) {
        if (claim !== null && typeof claim === 'object' && !Array.isArray(claim) && 'id' in claim && typeof claim.id === 'string') {
          retainedClaimIds.add(claim.id);
        }
      }
      continue;
    }
    collectProjectedClaimIds(nestedValue, retainedClaimIds);
  }
}

/** Accepts a claim only when it cites evidence and every citation names evidence the actor may read. */
function claimCitesOnlyReadableEvidence(claim: unknown, readableEvidenceIds: ReadonlySet<string>): boolean {
  if (
    claim === null
    || typeof claim !== 'object'
    || Array.isArray(claim)
    || !('citations' in claim)
    || !Array.isArray(claim.citations)
    || claim.citations.length === 0
  ) return false;
  return claim.citations.every((citation) =>
    citation !== null
    && typeof citation === 'object'
    && !Array.isArray(citation)
    && 'evidenceId' in citation
    && typeof citation.evidenceId === 'string'
    && readableEvidenceIds.has(citation.evidenceId)
  );
}

function mapRunListRow(row: RunRow) {
  return {
    runId: row.run_id, opportunityId: row.opportunity_id, opportunityName: row.opportunity_name,
    accountName: row.account_name, initiatedBy: row.initiated_by, status: row.status,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function mapApprovalInboxEntry(row: ApprovalRow): ApprovalInboxEntry {
  return {
    approvalSubjectId: row.approval_subject_id,
    runId: row.run_id,
    runVersion: row.run_version,
    subjectHash: row.subject_hash,
    opportunityId: row.opportunity_id,
    opportunityName: row.opportunity_name,
    accountName: row.account_name,
    entryId: row.entry_id,
    category: row.category as ApprovalInboxEntry['category'],
    requiredAuthorities: authorities(row.eligible_authorities),
    availableAuthority: approvalAuthority(row.available_authority),
    assignedApprover: row.decision_actor_name,
    quorum: { completed: row.completed_count, required: row.required_count },
    ageStartedAt: iso(row.subject_created_at),
    updatedAt: iso(row.decision_created_at ?? row.run_updated_at),
    decision: row.decision_action === null ? null : mapDecision({
      action: row.decision_action,
      authority: row.decision_authority ?? row.available_authority,
      rationale: row.decision_rationale,
      diff: row.decision_diff,
      created_at: row.decision_created_at ?? row.run_updated_at,
      actor_name: row.decision_actor_name ?? 'Approver'
    })
  };
}

function mapDecision(row: DecisionRow): ApprovalDecisionView {
  const diff = record(row.diff);
  const structured = approvalStructuredDiffSchema.safeParse({
    fields: diff?.fields ?? [],
    changedSections: diff?.changedSections ?? []
  });
  return {
    action: row.action as ApprovalDecisionView['action'], actorName: row.actor_name,
    authority: approvalAuthority(row.authority), rationale: row.rationale,
    decidedAt: iso(row.created_at), changed: diff?.changed === true,
    diff: diff?.changed === true && structured.success ? structured.data : null
  };
}

function authorities(value: unknown): ApprovalAuthority[] { return strings(value).map(approvalAuthority); }
function approvalAuthority(value: string): ApprovalAuthority {
  if (!['deal_desk', 'sales_leader', 'legal_reviewer', 'account_owner'].includes(value)) throw new TypeError('Persisted approval authority is invalid');
  return value as ApprovalAuthority;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new TypeError('Persisted string list is invalid');
  return value;
}
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}
function specialistDefault(status: RunStatus): 'pending' | 'running' | 'completed' | 'failed' {
  if (status === 'created' || status === 'retrieving') return 'pending';
  if (status === 'specialists_running') return 'running';
  if (status === 'failed') return 'failed';
  return 'completed';
}
function specialistStatusValue(value: string | undefined, fallback: ReturnType<typeof specialistDefault>): 'pending' | 'running' | 'completed' | 'degraded' | 'failed' {
  return value === 'completed' || value === 'degraded' || value === 'failed' ? value : fallback;
}
function phaseForEvent(event: EventRow, fallback: RunStatus): RunStatus {
  const payloadStatus = record(event.payload)?.status;
  if (typeof payloadStatus === 'string') {
    const parsed = runStatusSchema.safeParse(payloadStatus);
    if (parsed.success) return parsed.data;
  }
  const mapped: Partial<Record<string, RunStatus>> = {
    run_created: 'created', start: 'retrieving', retrieval_completed: 'specialists_running', specialists_completed: 'synthesizing',
    synthesis_completed: 'validating', validation_requires_approval: 'awaiting_approval', awaiting_approval: 'awaiting_approval',
    approval_entry_recorded: 'awaiting_approval', approval_granted: 'finalizing', approval_rejected: 'rejected',
    approval_subject_replaced: 'awaiting_approval', regeneration_requested: 'synthesizing', complete: 'completed', fail: 'failed', cancel: 'cancelled'
  };
  return mapped[event.type] ?? fallback;
}
function labelForEvent(type: string): string {
  const labels: Readonly<Record<string, string>> = {
    run_created: 'Run created', start: 'Retrieving authorized evidence', retrieval_completed: 'Evidence retrieval completed',
    specialists_completed: 'Specialist analysis completed', synthesis_completed: 'Brief synthesis completed',
    validation_requires_approval: 'Approval required', validation_completed: 'Brief validation completed', awaiting_approval: 'Awaiting approval',
    approval_entry_recorded: 'Approval recorded; quorum remains', approval_granted: 'Approval quorum satisfied', approval_rejected: 'Approval rejected',
    approval_subject_replaced: 'Edited brief submitted for approval', regeneration_requested: 'Brief regeneration requested',
    complete: 'Brief completed', fail: 'Run failed', cancel: 'Run cancelled', progress: 'Run progress updated'
  };
  return labels[type] ?? 'Run updated';
}
function iso(value: Date | string): string { return (value instanceof Date ? value : new Date(value)).toISOString(); }
