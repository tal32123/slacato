import type { CommandQueue, WorkflowCommand } from '@slacato/core';
import type { DatabaseClient } from '../db/client.js';
import type { CommandInspection } from './bullmq.js';

export interface LiveCommandInspector {
  state(commandId: string): Promise<'live' | 'completed' | 'failed' | 'missing'>;
  inspect?(commandId: string): Promise<CommandInspection>;
  reopenCompleted?(commandId: string): Promise<void>;
  publish?(command: WorkflowCommand): Promise<void>;
}

type OutboxRow = Readonly<{ id: string; run_id: string; type: string; payload: Record<string, unknown>; idempotency_key: string; claim_token: string | null }>;

/** Repairs Redis-loss ambiguity by returning stranded, nonterminal commands to the PostgreSQL outbox. */
export class PostgresCommandReconciler {
  private readonly owner = `reconciler_${crypto.randomUUID()}`;
  public constructor(private readonly database: DatabaseClient, private readonly commands: LiveCommandInspector, private readonly deadLetters?: CommandQueue) {}
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
        if (claimed !== undefined && await this.recoverCompletedClaim(claimed)) restored += 1;
      } else if (inspection.state === 'missing' || inspection.state === 'failed') {
        const result = await this.database.sql`update outbox_commands command set status = 'pending', available_at = now(), claimed_at = null
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
    const claimed = await this.database.sql<OutboxRow[]>`update outbox_commands command set status = 'claimed', claimed_at = now(), claim_owner = 'completed_recovery', claim_token = ${claimToken}, claim_expires_at = now() + interval '30 seconds'
      where command.id = ${row.id} and command.status = 'published' and command.consumed_at is null
        and not exists (select 1 from step_invocations invocation where invocation.causal_command_id = command.id and (invocation.status = 'completed' or (invocation.status = 'leased' and invocation.lease_expires_at > now())))
      returning command.id, command.run_id, command.type, command.payload, command.idempotency_key, command.claim_token`;
    return claimed[0];
  }

  /** Resumes a crash-safe completed-job recovery claim; every boundary is recoverable from PostgreSQL. */
  private async recoverCompletedClaims(limit: number): Promise<number> {
    const rows = await this.database.sql<OutboxRow[]>`select id, run_id, type, payload, idempotency_key, claim_token from outbox_commands
      where status = 'claimed' and claim_owner = 'completed_recovery' and consumed_at is null order by claimed_at nulls first limit ${limit}`;
    let restored = 0;
    for (const row of rows) if (await this.recoverCompletedClaim(row)) restored += 1;
    return restored;
  }

  private async recoverCompletedClaim(row: OutboxRow): Promise<boolean> {
    if (row.claim_token === null) return false;
    const inspection = await this.inspect(row.id);
    if (inspection.state === 'completed') {
      if (this.commands.reopenCompleted === undefined) return false;
      await this.commands.reopenCompleted(row.id);
    } else if (inspection.state === 'live' || inspection.state === 'failed') {
      return (await this.markRecoveredPublished(row)) > 0;
    }
    const marked = await this.markRecoveredPublished(row);
    if (marked === 0) return false;
    if (this.commands.publish === undefined) {
      await this.database.sql`update outbox_commands set status = 'pending', available_at = now(), published_at = null where id = ${row.id} and status = 'published' and consumed_at is null`;
      return true;
    }
    const command: WorkflowCommand = { id: row.id, runId: row.run_id as WorkflowCommand['runId'], type: row.type, payload: row.payload, idempotencyKey: row.idempotency_key };
    await this.commands.publish(command);
    return true;
  }

  private async markRecoveredPublished(row: OutboxRow): Promise<number> {
    const result = await this.database.sql`update outbox_commands set status = 'published', published_at = now(), claim_owner = null, claim_token = null, claim_expires_at = null
      where id = ${row.id} and status = 'claimed' and claim_owner = 'completed_recovery' and claim_token = ${row.claim_token} and consumed_at is null`;
    return result.count;
  }

  private async inspect(commandId: string): Promise<CommandInspection> {
    if (this.commands.inspect !== undefined) return this.commands.inspect(commandId);
    const state = await this.commands.state(commandId);
    return { state, attemptsMade: 0, maxAttempts: 0, exhausted: false };
  }

  private async claimAndPublishDeadLetter(row: OutboxRow, inspection: CommandInspection): Promise<void> {
    if (this.deadLetters === undefined) return;
    const claimToken = `dead_letter_${crypto.randomUUID()}`;
    const claimed = await this.database.sql<OutboxRow[]>`update outbox_commands command set status = 'dead_letter_claimed', claim_owner = ${this.owner}, claim_token = ${claimToken}, claim_expires_at = null
      where command.id = ${row.id} and command.status = 'published' and command.consumed_at is null
        and not exists (select 1 from step_invocations invocation where invocation.causal_command_id = command.id and (invocation.status = 'completed' or (invocation.status = 'leased' and invocation.lease_expires_at > now())))
      returning command.id, command.run_id, command.type, command.payload, command.idempotency_key, command.claim_token`;
    const claimedRow = claimed[0];
    if (claimedRow !== undefined) await this.publishAndAcknowledgeDeadLetter(claimedRow, inspection);
  }

  private async recoverClaimedDeadLetters(limit: number): Promise<void> {
    if (this.deadLetters === undefined) return;
    const rows = await this.database.sql<OutboxRow[]>`select id, run_id, type, payload, idempotency_key, claim_token from outbox_commands where status = 'dead_letter_claimed' and consumed_at is null order by claimed_at nulls first limit ${limit}`;
    for (const row of rows) await this.publishAndAcknowledgeDeadLetter(row, await this.inspect(row.id));
  }

  private async publishAndAcknowledgeDeadLetter(row: OutboxRow, inspection: CommandInspection): Promise<void> {
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
    await this.database.sql`update outbox_commands set status = 'dead_letter', claim_owner = null, claim_token = null, claim_expires_at = null
      where id = ${row.id} and status = 'dead_letter_claimed' and claim_token = ${row.claim_token}`;
  }

  /** Called by the eventual command processor only after its idempotent business transition commits. */
  public async markConsumed(commandId: string): Promise<void> {
    await this.database.sql`update outbox_commands set consumed_at = now() where id = ${commandId} and status = 'published' and consumed_at is null`;
  }
}

/** Bounded background reconciler. It is separate from delivery so Redis I/O never occurs in a database transaction. */
export class ReconcilerLoop {
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private running = false;
  public constructor(private readonly reconciler: PostgresCommandReconciler, private readonly pollMs = 5_000, private readonly batchSize = 25, private readonly onTransientError: () => void = () => {}) {}
  public start(): void { if (this.timer === undefined) void this.tick(); }
  public async stop(): Promise<void> { this.stopping = true; if (this.timer !== undefined) clearTimeout(this.timer); while (this.running) await new Promise((resolve) => setTimeout(resolve, 10)); }
  private async tick(): Promise<void> {
    this.running = true;
    let delay = this.pollMs;
    try { await this.reconciler.reconcile(this.batchSize); } catch { delay = Math.min(this.pollMs * 2, 30_000); this.onTransientError(); } finally { this.running = false; }
    if (!this.stopping) this.timer = setTimeout(() => void this.tick(), delay);
  }
}
