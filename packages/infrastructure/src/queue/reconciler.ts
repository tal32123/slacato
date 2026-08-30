import { type CommandQueue, DomainConflictError, type WorkflowCommand } from '@slacato/core';
import type { DatabaseClient } from '../db/client.js';
import { persistTraceProjection } from '../db/repositories/workflow-store.js';
import { projectWorkflowTrace } from '../db/repositories/workflow-trace-projector.js';
import type { CommandInspection } from './bullmq.js';

/** Queue capabilities needed to recover every live-command state without stranding a durable claim. */
export interface LiveCommandInspector extends CommandQueue {
  state(commandId: string): Promise<'live' | 'completed' | 'failed' | 'missing'>;
  reopenCompleted(commandId: string): Promise<void>;
}

/** Complete live-command capabilities for reconciliation that also classifies exhausted deliveries. */
export interface ExhaustionAwareLiveCommandInspector extends LiveCommandInspector {
  inspect(commandId: string): Promise<CommandInspection>;
}

/** Distinguishes queues that can report retry exhaustion for dead-letter reconciliation. */
function isExhaustionAware(
  inspector: LiveCommandInspector
): inspector is ExhaustionAwareLiveCommandInspector {
  return 'inspect' in inspector && typeof inspector.inspect === 'function';
}

/** Rejects incomplete runtime adapters before reconciliation can mutate an outbox row. */
function assertRecoveryCapabilities(inspector: LiveCommandInspector): void {
  if (
    typeof inspector.state !== 'function' ||
    typeof inspector.reopenCompleted !== 'function' ||
    typeof inspector.publish !== 'function'
  ) {
    throw new TypeError(
      'Live command reconciliation requires state, reopenCompleted, and publish capabilities'
    );
  }
}

type OutboxRow = Readonly<{
  id: string;
  run_id: string;
  type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  claim_token: string | null;
}>;

/** Repairs stranded commands while keeping PostgreSQL recovery claims resumable after failures. */
export class PostgresCommandReconciler {
  private readonly owner = `reconciler_${crypto.randomUUID()}`;
  private readonly database: DatabaseClient;
  private readonly commands: LiveCommandInspector;
  private readonly deadLetters: CommandQueue | undefined;

  /** Configures command recovery and optional exhausted-delivery dead lettering. */
  public constructor(database: DatabaseClient, commands: LiveCommandInspector);
  public constructor(
    database: DatabaseClient,
    commands: ExhaustionAwareLiveCommandInspector,
    deadLetters: CommandQueue
  );
  public constructor(
    database: DatabaseClient,
    commands: LiveCommandInspector,
    deadLetters?: CommandQueue
  ) {
    assertRecoveryCapabilities(commands);
    if (deadLetters !== undefined && !isExhaustionAware(commands)) {
      throw new TypeError('Dead-letter reconciliation requires inspect capability');
    }
    this.database = database;
    this.commands = commands;
    this.deadLetters = deadLetters;
  }
  /** Repairs stranded published commands and resumes incomplete recovery claims. */
  public async reconcile(limit = 25): Promise<number> {
    let restored = await this.recoverCompletedClaims(limit);
    const rows = await this.database.sql<OutboxRow[]>`
      select command.id, command.run_id, command.type, command.payload, command.idempotency_key, command.claim_token from outbox_commands command join runs run on run.id = command.run_id
      where command.status = 'published' and command.consumed_at is null and run.status not in ('completed', 'rejected', 'failed')
      and not exists (select 1 from step_invocations invocation where invocation.run_id = run.id and invocation.status = 'leased' and invocation.lease_expires_at > now())
      order by command.published_at nulls first limit ${limit}
    `;
    for (const row of rows) {
      const inspection = await this.inspect(row.id);
      if (inspection.state === 'failed' && inspection.exhausted) {
        await this.claimAndPublishDeadLetter(row, inspection);
      } else if (inspection.state === 'completed') {
        const claimed = await this.claimCompletedForRecovery(row);
        if (claimed !== undefined && (await this.recoverCompletedClaim(claimed))) restored += 1;
      } else if (inspection.state === 'missing' || inspection.state === 'failed') {
        const result = await this.database
          .sql`update outbox_commands command set status = 'pending', available_at = now(), claimed_at = null
          where command.id = ${row.id} and command.status = 'published' and command.consumed_at is null
            and not exists (select 1 from step_invocations invocation where invocation.causal_command_id = command.id and (invocation.status = 'completed' or (invocation.status = 'leased' and invocation.lease_expires_at > now())))`;
        if (result.count > 0) restored += 1;
      }
    }
    await this.recoverClaimedDeadLetters(limit);
    return restored;
  }

  /** Fences the outbox row before removing a terminal BullMQ job, so a consumer cannot race the replay. */
  private async claimCompletedForRecovery(row: OutboxRow): Promise<OutboxRow | undefined> {
    const claimToken = `completed_recovery_${crypto.randomUUID()}`;
    const claimed = await this.database.sql<
      OutboxRow[]
    >`update outbox_commands command set status = 'claimed', claimed_at = now(), claim_owner = 'completed_recovery', claim_token = ${claimToken}, claim_expires_at = now() + interval '30 seconds'
      where command.id = ${row.id} and command.status = 'published' and command.consumed_at is null
        and not exists (select 1 from step_invocations invocation where invocation.causal_command_id = command.id and (invocation.status = 'completed' or (invocation.status = 'leased' and invocation.lease_expires_at > now())))
      returning command.id, command.run_id, command.type, command.payload, command.idempotency_key, command.claim_token`;
    return claimed[0];
  }

  /** Resumes a crash-safe completed-job recovery claim; every boundary is recoverable from PostgreSQL. */
  private async recoverCompletedClaims(limit: number): Promise<number> {
    const rows = await this.database.sql<
      OutboxRow[]
    >`select id, run_id, type, payload, idempotency_key, claim_token from outbox_commands
      where status = 'claimed' and claim_owner = 'completed_recovery' and consumed_at is null order by claimed_at nulls first limit ${limit}`;
    let restored = 0;
    for (const row of rows) if (await this.recoverCompletedClaim(row)) restored += 1;
    return restored;
  }

  /** Reopens and republishes a completed recovery claim, or resumes at the last recoverable boundary. */
  private async recoverCompletedClaim(row: OutboxRow): Promise<boolean> {
    if (row.claim_token === null) return false;
    const inspection = await this.inspect(row.id);
    if (inspection.state === 'completed') {
      await this.commands.reopenCompleted(row.id);
    } else if (inspection.state === 'live' || inspection.state === 'failed') {
      return (await this.markRecoveredPublished(row)) > 0;
    }
    const marked = await this.markRecoveredPublished(row);
    if (marked === 0) return false;
    const command: WorkflowCommand = {
      id: row.id,
      runId: row.run_id as WorkflowCommand['runId'],
      type: row.type,
      payload: row.payload,
      idempotencyKey: row.idempotency_key
    };
    await this.commands.publish(command);
    return true;
  }

  /** Returns a completed-recovery claim to published state when its fencing token still matches. */
  private async markRecoveredPublished(row: OutboxRow): Promise<number> {
    const result = await this.database
      .sql`update outbox_commands set status = 'published', published_at = now(), claim_owner = null, claim_token = null, claim_expires_at = null
      where id = ${row.id} and status = 'claimed' and claim_owner = 'completed_recovery' and claim_token = ${row.claim_token} and consumed_at is null`;
    return result.count;
  }

  /** Returns detailed delivery state when the configured queue supports exhausted-job recovery. */
  private async inspect(commandId: string): Promise<CommandInspection> {
    if (isExhaustionAware(this.commands)) return this.commands.inspect(commandId);
    const state = await this.commands.state(commandId);
    return { state, attemptsMade: 0, maxAttempts: 0, exhausted: false };
  }

  /** Claims an exhausted command before publishing its dead-letter record. */
  private async claimAndPublishDeadLetter(
    row: OutboxRow,
    inspection: CommandInspection
  ): Promise<void> {
    if (this.deadLetters === undefined) return;
    const claimToken = `dead_letter_${crypto.randomUUID()}`;
    const claimed = await this.database.sql<
      OutboxRow[]
    >`update outbox_commands command set status = 'dead_letter_claimed', claim_owner = ${this.owner}, claim_token = ${claimToken}, claim_expires_at = null
      where command.id = ${row.id} and command.status = 'published' and command.consumed_at is null
        and not exists (select 1 from step_invocations invocation where invocation.causal_command_id = command.id and (invocation.status = 'completed' or (invocation.status = 'leased' and invocation.lease_expires_at > now())))
      returning command.id, command.run_id, command.type, command.payload, command.idempotency_key, command.claim_token`;
    const claimedRow = claimed[0];
    if (claimedRow !== undefined)
      await this.publishAndAcknowledgeDeadLetter(claimedRow, inspection);
  }

  /** Resumes dead-letter publications left claimed by an interrupted reconciler. */
  private async recoverClaimedDeadLetters(limit: number): Promise<void> {
    if (this.deadLetters === undefined) return;
    const rows = await this.database.sql<
      OutboxRow[]
    >`select id, run_id, type, payload, idempotency_key, claim_token from outbox_commands where status = 'dead_letter_claimed' and consumed_at is null order by claimed_at nulls first limit ${limit}`;
    for (const row of rows)
      await this.publishAndAcknowledgeDeadLetter(row, await this.inspect(row.id));
  }

  /** Publishes an exhausted command's safe dead-letter record before acknowledging its claim. */
  private async publishAndAcknowledgeDeadLetter(
    row: OutboxRow,
    inspection: CommandInspection
  ): Promise<void> {
    if (this.deadLetters === undefined || row.claim_token === null) return;
    const command: WorkflowCommand = {
      id: row.id,
      runId: row.run_id as WorkflowCommand['runId'],
      type: row.type,
      payload: {
        commandId: row.id,
        type: row.type,
        reason: 'processor_attempts_exhausted',
        attemptsMade: inspection.attemptsMade,
        maxAttempts: inspection.maxAttempts
      },
      idempotencyKey: row.id
    };
    await this.deadLetters.publish(command);
    await this.acknowledgeDeadLetter(row);
  }

  /** Atomically acknowledges the dead letter and fails only the still-active run that owns it. */
  private async acknowledgeDeadLetter(row: OutboxRow): Promise<void> {
    await this.database.sql.begin(async (sql) => {
      const acknowledged = await sql<
        { run_id: string }[]
      >`update outbox_commands set status = 'dead_letter', claim_owner = null, claim_token = null, claim_expires_at = null
        where id = ${row.id} and status = 'dead_letter_claimed' and claim_token = ${row.claim_token}
        returning run_id`;
      const runId = acknowledged[0]?.run_id;
      if (runId === undefined) return;
      const failed = await sql<
        { version: number }[]
      >`update runs set status = 'failed', version = version + 1, updated_at = now()
        where id = ${runId}
          and status in ('created', 'retrieving', 'specialists_running', 'synthesizing', 'validating', 'awaiting_approval', 'finalizing')
        returning version`;
      const version = failed[0]?.version;
      if (version === undefined) return;
      const failureProjection = projectWorkflowTrace({
        type: 'failed',
        runId,
        version,
        reason: 'processor_attempts_exhausted'
      });
      await persistTraceProjection(sql, failureProjection);
      const reasonCode = failureProjection.failureReasonCode;
      if (reasonCode === undefined)
        throw new DomainConflictError('Failure trace has no diagnostic code');
      await sql`select pg_advisory_xact_lock(hashtext(${`run-events:${runId}`}))`;
      const payload = JSON.stringify({ version, reasonCode, terminal: true });
      await sql`insert into run_events (id, run_id, sequence, type, version, payload, created_at)
        select ${`event_${crypto.randomUUID()}`}, ${runId}, coalesce(max(sequence), 0) + 1, 'fail', 1,
          ${payload}::jsonb, now()
        from run_events where run_id = ${runId}`;
      await sql`select pg_notify('slacato_run_events', ${runId})`;
    });
  }

  /** Called by the eventual command processor only after its idempotent business transition commits. */
  public async markConsumed(commandId: string): Promise<void> {
    await this.database
      .sql`update outbox_commands set consumed_at = now() where id = ${commandId} and status = 'published' and consumed_at is null`;
  }
}

/** Runs bounded background reconciliation separately from delivery so Redis I/O never occurs in a database transaction. */
export class ReconcilerLoop {
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private running = false;
  /** Configures bounded polling for command reconciliation. */
  public constructor(
    private readonly reconciler: PostgresCommandReconciler,
    private readonly pollMs = 5_000,
    private readonly batchSize = 25,
    private readonly onTransientError: () => void = () => {}
  ) {}
  /** Starts reconciliation polling when the loop is not already active. */
  public start(): void {
    if (this.timer === undefined) void this.tick();
  }
  /** Stops future polling and waits for the active reconciliation pass to finish. */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  /** Runs one reconciliation pass and schedules the next poll with bounded failure backoff. */
  private async tick(): Promise<void> {
    this.running = true;
    let delay = this.pollMs;
    try {
      await this.reconciler.reconcile(this.batchSize);
    } catch {
      delay = Math.min(this.pollMs * 2, 30_000);
      this.onTransientError();
    } finally {
      this.running = false;
    }
    if (!this.stopping) this.timer = setTimeout(() => void this.tick(), delay);
  }
}
