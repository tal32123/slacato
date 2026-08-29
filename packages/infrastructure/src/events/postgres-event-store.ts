import type { ListenMeta } from 'postgres';
import {
  runEventEnvelopeSchema,
  runEventToPublishSchema,
  runSnapshotSchema,
  traceSpanSchema,
  type RunEventEnvelope,
  type RunEventToPublish,
  type RunSnapshot,
  type TraceSpan
} from '@slacato/contracts';
import {
  CursorExpiredError,
  TraceCompletenessError,
  DomainConflictError,
  assertTraceComplete as validateTraceComplete,
  canonicalJson,
  createRunEventSubscription,
  type RunEventBus,
  type RunEventQuery,
  type RunEventSubscriptionSource,
  type TraceStore
} from '@slacato/core';
import type { DatabaseClient } from '../db/client.js';

const CHANNEL = 'slacato_run_events';
const REPLAY_PAGE_SIZE = 256;
const REPLAY_RECONCILIATION_INTERVAL_MS = 1_000;

type EventRow = Readonly<{
  id: string;
  run_id: string;
  sequence: number;
  type: string;
  version: number;
  payload: Record<string, unknown>;
  created_at: Date | string;
}>;

type TraceRow = Readonly<{
  trace_id: string;
  span_id: string;
  run_id: string;
  parent_id: string | null;
  step: string;
  attempt: number;
  kind: TraceSpan['kind'];
  status: TraceSpan['status'];
  payload: Record<string, unknown>;
  started_at: Date | string;
  ended_at: Date | string | null;
}>;

type WakeWaiter = Readonly<{ resolve: () => void; abort: () => void }>;

function envelopeFromRow(row: EventRow): RunEventEnvelope {
  return runEventEnvelopeSchema.parse({
    id: row.id,
    streamId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    version: row.version,
    timestamp: new Date(row.created_at).toISOString(),
    payload: row.payload
  }) as RunEventEnvelope;
}

function traceFromRow(row: TraceRow): TraceSpan {
  return traceSpanSchema.parse({
    traceId: row.trace_id,
    spanId: row.span_id,
    runId: row.run_id,
    ...(row.parent_id === null ? {} : { parentSpanId: row.parent_id }),
    step: row.step,
    attempt: row.attempt,
    kind: row.kind,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    ...(row.ended_at === null ? {} : { endedAt: new Date(row.ended_at).toISOString() }),
    data: row.payload
  });
}

/** PostgreSQL-authoritative append/replay store. LISTEN/NOTIFY is only a wake-up hint. */
export class PostgresEventStore implements RunEventBus, RunEventSubscriptionSource, TraceStore {
  private readonly waiters = new Map<string, Set<WakeWaiter>>();
  private listener: Promise<ListenMeta> | undefined;
  private reconciliation: NodeJS.Timeout | undefined;
  private closed = false;

  public constructor(private readonly database: DatabaseClient) {}

  public async start(): Promise<void> {
    await this.ensureListener();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const streamWaiters of this.waiters.values()) for (const waiter of streamWaiters) waiter.abort();
    this.waiters.clear();
    clearInterval(this.reconciliation);
    if (this.listener !== undefined) await (await this.listener).unlisten();
  }
  public async onModuleDestroy(): Promise<void> {
    await this.close();
  }



  public async publish(input: RunEventToPublish): Promise<void> {
    const envelope = runEventToPublishSchema.parse(input);
    await this.database.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`run-events:${envelope.streamId}`}))`;
      const prior = (await sql<EventRow[]>`select id, run_id, sequence, type, version, payload, created_at from run_events where id = ${envelope.id}`)[0];
      if (prior !== undefined) {
        const priorEnvelope = envelopeFromRow(prior);
        const comparable = { id: priorEnvelope.id, streamId: priorEnvelope.streamId, type: priorEnvelope.type, version: priorEnvelope.version, timestamp: priorEnvelope.timestamp, payload: priorEnvelope.payload };
        if (canonicalJson(comparable) !== canonicalJson(envelope)) throw new DomainConflictError('Run event ID conflicts with another event');
        return;
      }
      await sql`insert into run_events (id, run_id, sequence, type, version, payload, created_at)
        select ${envelope.id}, ${envelope.streamId}, coalesce(max(sequence), 0) + 1, ${envelope.type}, ${envelope.version},
          ${JSON.stringify(envelope.payload)}::jsonb, ${envelope.timestamp}::timestamptz
        from run_events where run_id = ${envelope.streamId}`;
      await sql`select pg_notify(${CHANNEL}, ${envelope.streamId})`;
    });
  }

  public subscribe(streamId: string, afterId?: string, signal?: AbortSignal): AsyncIterable<RunEventEnvelope> {
    return createRunEventSubscription(this, streamId, afterId, signal);
  }

  public async resolveCursor(streamId: string, afterId: string | undefined): Promise<number> {
    await this.ensureListener();
    if (afterId === undefined) return 0;
    const row = (await this.database.sql<{ sequence: number }[]>`select sequence from run_events where run_id = ${streamId} and id = ${afterId}`)[0];
    if (row === undefined) throw new CursorExpiredError();
    return row.sequence;
  }

  public async readAfter(streamId: string, afterSequence: number): Promise<readonly RunEventEnvelope[]> {
    const rows = await this.database.sql<EventRow[]>`select id, run_id, sequence, type, version, payload, created_at
      from run_events where run_id = ${streamId} and sequence > ${afterSequence}
      order by sequence limit ${REPLAY_PAGE_SIZE}`;
    return rows.map(envelopeFromRow);
  }

  public waitForWake(streamId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.closed) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const streamWaiters = this.waiters.get(streamId) ?? new Set<WakeWaiter>();
    this.waiters.set(streamId, streamWaiters);
    let settled = false;
    let waiter: WakeWaiter;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cleanup);
      streamWaiters.delete(waiter);
      if (streamWaiters.size === 0) this.waiters.delete(streamId);
      resolve();
    };
    waiter = { resolve: cleanup, abort: cleanup };
    streamWaiters.add(waiter);
    signal.addEventListener('abort', cleanup, { once: true });
    if (signal.aborted) cleanup();
    return promise;
  }

  public async appendTrace(input: TraceSpan): Promise<void> {
    const span = traceSpanSchema.parse(input);
    await this.database.sql.begin(async (sql) => {
      const existing = (await sql<TraceRow[]>`select trace_id, span_id, run_id, parent_id, step, attempt, kind, status, payload, started_at, ended_at
        from trace_spans where id = ${span.spanId}`)[0];
      if (existing !== undefined) {
        if (canonicalJson(traceFromRow(existing)) !== canonicalJson(span)) throw new DomainConflictError('Trace span ID conflicts with another span');
        return;
      }
      await sql`insert into trace_spans (id, trace_id, span_id, run_id, parent_id, step, attempt, kind, status, payload, started_at, ended_at)
        values (${span.spanId}, ${span.traceId}, ${span.spanId}, ${span.runId}, ${span.parentSpanId ?? null}, ${span.step}, ${span.attempt},
          ${span.kind}, ${span.status}, ${JSON.stringify(span.data)}::jsonb, ${span.startedAt}::timestamptz, ${span.endedAt ?? null}::timestamptz)`;
    });
  }

  public async tracesForRun(runId: string): Promise<readonly TraceSpan[]> {
    const rows = await this.database.sql<TraceRow[]>`select trace_id, span_id, run_id, parent_id, step, attempt, kind, status, payload, started_at, ended_at
      from trace_spans where run_id = ${runId} order by started_at, span_id`;
    return rows.map(traceFromRow);
  }

  public async assertTraceComplete(runId: string): Promise<void> {
    const spans = await this.tracesForRun(runId);
    validateTraceComplete(runId, spans);
    const decisions = await this.database.sql<{
      entry_id: string;
      category: string;
      authority: string;
      approved_subject_hash: string;
    }[]>`select decision.entry_id, decision.category, decision.authority, decision.approved_subject_hash
      from approval_decisions decision
      join approval_subjects subject on subject.id = decision.approval_subject_id
      where subject.run_id = ${runId}`;
    for (const decision of decisions) {
      const traced = spans.some((span) => span.kind === 'approval_decision'
        && span.data.entryId === decision.entry_id
        && span.data.category === decision.category
        && span.data.authority === decision.authority
        && span.data.subjectHash === decision.approved_subject_hash);
      if (!traced) throw new TraceCompletenessError(`Trace is missing persisted approval decision ${decision.entry_id}`);
    }
    const requirements = await this.database.sql<{
      entry_id: string;
      category: string;
      eligible_authorities: string[];
      subject_hash: string;
    }[]>`select entry.id entry_id, entry.category, entry.eligible_authorities, subject.subject_hash
      from approval_requirement_entries entry
      join approval_subjects subject on subject.id = entry.approval_subject_id
      where subject.run_id = ${runId}`;
    for (const requirement of requirements) {
      const traced = spans.some((span) => span.kind === 'approval_requirement'
        && span.data.entryId === requirement.entry_id
        && span.data.category === requirement.category
        && span.data.subjectHash === requirement.subject_hash
        && canonicalJson(span.data.authorities) === canonicalJson(requirement.eligible_authorities));
      if (!traced) throw new TraceCompletenessError(`Trace is missing persisted approval requirement ${requirement.entry_id}`);
    }
  }

  private async ensureListener(): Promise<void> {
    if (this.closed) throw new Error('Postgres event store is closed');
    this.listener ??= this.database.sql.listen(CHANNEL, (streamId) => this.wake(streamId));
    this.reconciliation ??= setInterval(() => {
      for (const streamId of this.waiters.keys()) this.wake(streamId);
    }, REPLAY_RECONCILIATION_INTERVAL_MS);
    this.reconciliation.unref();
    await this.listener;
  }

  private wake(streamId: string): void {
    const streamWaiters = this.waiters.get(streamId);
    if (streamWaiters === undefined) return;
    for (const waiter of [...streamWaiters]) waiter.resolve();
  }
}

/** Opaque run-level authorization and snapshot watermark query for the HTTP boundary. */
export class PostgresRunEventQuery implements RunEventQuery {
  public constructor(private readonly database: DatabaseClient) {}

  public async authorizeAndSnapshot(streamId: string, actorId: string): Promise<RunSnapshot | undefined> {
    const row = (await this.database.sql<{
      id: string;
      status: string;
      version: number;
      watermark: string | null;
    }[]>`select run.id, run.status, run.version,
        (select event.id from run_events event where event.run_id = run.id order by event.sequence desc limit 1) watermark
      from runs run
      join opportunities opportunity on opportunity.id = run.opportunity_id
      where run.id = ${streamId} and run.requested_by = ${actorId}
        and exists (
          select 1 from permission_grants permission
          where permission.persona_id = ${actorId}
            and permission.account_id = opportunity.account_id
            and permission.can_read
            and (not opportunity.restricted or permission.can_read_restricted)
        )`)[0];
    if (row === undefined) return undefined;
    return runSnapshotSchema.parse({
      streamId: row.id,
      status: row.status,
      version: row.version,
      watermark: row.watermark,
      terminal: ['completed', 'failed', 'rejected'].includes(row.status)
    });
  }
}
