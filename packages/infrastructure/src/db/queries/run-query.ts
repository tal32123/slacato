import {
  type RunDetailResponse,
  type RunEventType,
  type RunListResponse,
  type RunStatus,
  runDetailResponseSchema,
  runEventFallbackStatuses,
  runListResponseSchema,
  runStatusSchema
} from '@slacato/contracts';
import { CANONICAL_FIXTURE_COMMIT } from '@slacato/core';
import type { DatabaseClient } from '../client.js';

type RunRow = Readonly<{
  run_id: string;
  opportunity_id: string;
  opportunity_name: string;
  account_name: string;
  initiated_by: string;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}>;
type EventRow = Readonly<{
  id: string;
  sequence: number;
  type: RunEventType;
  payload: unknown;
  created_at: Date | string;
}>;
type QueryPrincipal = Readonly<{ actorId: string; sessionVersion: string }>;
type DefaultSpecialistStatus = 'pending' | 'running' | 'completed' | 'failed';

const sectionNames = [
  'Deal Snapshot',
  'Executive Summary',
  'Buyer Goals and Business Drivers',
  'Stakeholder Map',
  'Negotiation State',
  'Recommended Next Actions',
  'Missing Information',
  'Source Evidence',
  'Confidence and Review Warnings'
] as const;
const specialistNames = ['conversation', 'stakeholder', 'commercial'] as const;
const terminalStatuses: readonly RunStatus[] = ['completed', 'rejected', 'failed', 'cancelled'];

/** Queries runs through canonical authorization views. */
export class PostgresRunQueryRepository {
  /** Initializes run queries with a database client. */
  public constructor(private readonly database: DatabaseClient) {}

  /** Lists the runs visible through opportunity access or approval authority. */
  public async listRuns({ actorId, sessionVersion }: QueryPrincipal): Promise<RunListResponse> {
    const rows = await this.database.sql<RunRow[]>`
      select run.id run_id, opportunity.id opportunity_id, opportunity.name opportunity_name,
        account.name account_name, requester.display_name initiated_by, run.status, run.version,
        run.created_at, run.updated_at
      from runs run
      join opportunities opportunity on opportunity.id = run.opportunity_id
      join accounts account on account.id = opportunity.account_id
      join personas requester on requester.id = run.requested_by
      where exists (
        select 1 from authorized_opportunity_grants opportunity_grant
        where opportunity_grant.persona_id = ${actorId}
          and opportunity_grant.opportunity_id = opportunity.id
          and opportunity_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
      ) or exists (
        select 1 from authorized_run_approval_grants approval_grant
        where approval_grant.persona_id = ${actorId}
          and approval_grant.run_id = run.id
          and approval_grant.opportunity_id = opportunity.id
          and approval_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
      )
      order by run.updated_at desc, run.id desc limit 1000`;
    return runListResponseSchema.parse({ sessionVersion, runs: rows.map(mapRunListRow) });
  }

  /** Returns one visible run with its derived workflow progress. */
  public async getRun(
    { actorId, sessionVersion }: QueryPrincipal,
    runId: string
  ): Promise<RunDetailResponse | undefined> {
    const row = (
      await this.database.sql<RunRow[]>`
      select run.id run_id, opportunity.id opportunity_id, opportunity.name opportunity_name,
        account.name account_name, requester.display_name initiated_by, run.status, run.version,
        run.created_at, run.updated_at
      from runs run
      join opportunities opportunity on opportunity.id = run.opportunity_id
      join accounts account on account.id = opportunity.account_id
      join personas requester on requester.id = run.requested_by
      where run.id = ${runId} and (
        exists (
          select 1 from authorized_opportunity_grants opportunity_grant
          where opportunity_grant.persona_id = ${actorId}
            and opportunity_grant.opportunity_id = opportunity.id
            and opportunity_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
        ) or exists (
          select 1 from authorized_run_approval_grants approval_grant
          where approval_grant.persona_id = ${actorId}
            and approval_grant.run_id = run.id
            and approval_grant.opportunity_id = opportunity.id
            and approval_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
        )
      ) limit 1`
    )[0];
    if (row === undefined) return undefined;

    const [events, specialistRows, retrievalRows, validationRows, strategyRows] = await Promise.all(
      [
        this.database.sql<
          EventRow[]
        >`select id, sequence, type, payload, created_at from run_events where run_id = ${runId} order by sequence desc limit 200`,
        this.database.sql<
          { step: string; status: string | null }[]
        >`select distinct on (step) step, payload->>'status' status from workflow_checkpoints where run_id = ${runId} and step like 'specialist:%' order by step, created_at desc, id desc`,
        this.database.sql<
          { evidence_count: number | null }[]
        >`select max((payload->>'evidenceCount')::integer) evidence_count from trace_spans where run_id = ${runId} and kind = 'evidence_retrieval'`,
        this.database.sql<
          { retry_count: number | null }[]
        >`select coalesce(sum(validation_attempts), 0)::integer retry_count from generation_attempts where run_id = ${runId}`,
        this.database.sql<{ present: boolean }[]>`select exists(
        select 1 from workflow_checkpoints where run_id = ${runId} and step like 'validation:%' and payload->>'status' = 'completed'
        union all select 1 from approval_subjects where run_id = ${runId}
      ) present`
      ]
    );
    const orderedEvents = [...events].reverse();
    const status = runStatusSchema.parse(row.status);
    const watermark = orderedEvents.at(-1);
    const specialistStatus = new Map(
      specialistRows.map((item) => [item.step.slice('specialist:'.length), item.status])
    );
    const fallback = defaultSpecialistStatus(status);
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
      createdAt: toIsoTimestamp(row.created_at),
      updatedAt: toIsoTimestamp(row.updated_at),
      progress: {
        phase: status,
        retrievalCount: retrievalRows[0]?.evidence_count ?? 0,
        validationRetries: validationRows[0]?.retry_count ?? 0,
        specialists: specialistNames.map((name) => ({
          name,
          status: resolveSpecialistStatus(specialistStatus.get(name) ?? undefined, fallback)
        })),
        completedSections: strategyRows[0]?.present === true ? sectionNames : [],
        timeline: orderedEvents.map((event) => ({
          sequence: event.sequence,
          eventId: event.id,
          phase: phaseForEvent(event, status),
          label: labelForEvent(event.type),
          at: toIsoTimestamp(event.created_at)
        }))
      }
    });
  }
}

/** Maps a run row to its list response shape. */
function mapRunListRow(row: RunRow) {
  return {
    runId: row.run_id,
    opportunityId: row.opportunity_id,
    opportunityName: row.opportunity_name,
    accountName: row.account_name,
    initiatedBy: row.initiated_by,
    status: row.status,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at)
  };
}

/** Returns an object value as a read-only record. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
/** Derives the default specialist status from the run status. */
function defaultSpecialistStatus(status: RunStatus): DefaultSpecialistStatus {
  if (status === 'created' || status === 'retrieving') return 'pending';
  if (status === 'specialists_running') return 'running';
  if (status === 'failed') return 'failed';
  return 'completed';
}
/** Resolves a reported specialist status or uses the fallback. */
function resolveSpecialistStatus(
  value: string | undefined,
  fallback: DefaultSpecialistStatus
): 'pending' | 'running' | 'completed' | 'degraded' | 'failed' {
  return value === 'completed' || value === 'degraded' || value === 'failed' ? value : fallback;
}
/** Resolves the run phase represented by an event. */
function phaseForEvent(event: EventRow, fallback: RunStatus): RunStatus {
  const payloadStatus = asRecord(event.payload)?.status;
  if (typeof payloadStatus === 'string') {
    const parsed = runStatusSchema.safeParse(payloadStatus);
    if (parsed.success) return parsed.data;
  }
  const mapped = runStatusSchema.safeParse(runEventFallbackStatuses[event.type]);
  return mapped.success ? mapped.data : fallback;
}
/** Returns the display label for a run event type. */
function labelForEvent(type: string): string {
  const labels: Readonly<Record<string, string>> = {
    run_created: 'Run created',
    start: 'Retrieving authorized evidence',
    retrieval_completed: 'Evidence retrieval completed',
    specialists_completed: 'Specialist analysis completed',
    synthesis_completed: 'Brief synthesis completed',
    validation_requires_approval: 'Approval required',
    validation_completed: 'Brief validation completed',
    awaiting_approval: 'Awaiting approval',
    approval_entry_recorded: 'Approval recorded; quorum remains',
    approval_granted: 'Approval quorum satisfied',
    approval_rejected: 'Approval rejected',
    approval_subject_replaced: 'Edited brief submitted for approval',
    regeneration_requested: 'Brief regeneration requested',
    complete: 'Brief completed',
    fail: 'Run failed',
    cancel: 'Run cancelled',
    progress: 'Run progress updated'
  };
  return labels[type] ?? 'Run updated';
}
/** Converts a database timestamp to ISO 8601 format. */
function toIsoTimestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
