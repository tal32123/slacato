import type { CommandQueue, WorkflowCommand } from '@slacato/core';
import type { Logger } from 'pino';
import type { DatabaseClient } from '../db/client.js';
import { logger } from '../logging/logger.js';
import { reportLoopFailure } from '../logging/loop-telemetry.js';
import type { CommandInspection } from './bullmq.js';

type OutboxRow = Readonly<{
  id: string;
  run_id: string;
  type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  delivery_attempts: number;
  claim_token: string;
}>;

/** Multi-replica-safe outbox publisher: database claims are short; Redis I/O happens outside transactions. */
export class OutboxDispatcher {
  private readonly owner = `dispatcher_${crypto.randomUUID()}`;
  /** Configures durable command delivery, dead letters, retry limits, and claim leases. */
  public constructor(
    private readonly database: DatabaseClient,
    private readonly commandQueue: CommandQueue,
    private readonly deadLetterQueue: CommandQueue,
    private readonly maxAttempts = 3,
    private readonly claimLeaseMs = 30_000,
    private readonly telemetry: Logger = logger
  ) {}

  /** Claims and publishes one bounded batch while preserving safe retry and dead-letter outcomes. */
  public async dispatchBatch(
    limit = 25
  ): Promise<Readonly<{ claimed: number; published: number; deadLettered: number }>> {
    const claimToken = `outbox_claim_${crypto.randomUUID()}`;
    const claimed = await this.database.sql.begin(
      async (sql) => sql<OutboxRow[]>`
      with candidates as (
        select id from outbox_commands where (status = 'pending' and available_at <= now()) or (status = 'claimed' and claim_expires_at <= now()) order by available_at, id for update skip locked limit ${limit}
      )
      update outbox_commands command set status = 'claimed', claimed_at = now(), claim_owner = ${this.owner}, claim_token = ${claimToken}, claim_expires_at = now() + (${this.claimLeaseMs} * interval '1 millisecond'), delivery_attempts = command.delivery_attempts + 1
      from candidates where command.id = candidates.id
      returning command.id, command.run_id, command.type, command.payload, command.idempotency_key, command.delivery_attempts, command.claim_token
    `
    );
    let published = 0;
    let deadLettered = 0;
    for (const row of claimed) {
      const command: WorkflowCommand = {
        id: row.id,
        runId: row.run_id as WorkflowCommand['runId'],
        type: row.type,
        payload: row.payload,
        idempotencyKey: row.idempotency_key
      };
      try {
        await this.commandQueue.publish(command);
        if (await this.markPublished(row)) published += 1;
      } catch (error) {
        const acceptance = await this.inspectAcceptance(row.id);
        if (acceptance === 'accepted') {
          if (await this.markPublished(row)) published += 1;
          this.reportDelivery(row, error, 'outbox_command_delivery_recovered', 'published');
        } else if (acceptance === 'ambiguous') {
          this.reportDelivery(row, error, 'outbox_command_delivery_ambiguous', 'claimed');
          await this.database
            .sql`update outbox_commands set delivery_attempts = greatest(delivery_attempts - 1, 0)
            where id = ${row.id} and status = 'claimed' and claim_token = ${row.claim_token}`;
        } else if (row.delivery_attempts >= this.maxAttempts) {
          const safeCommand: WorkflowCommand = {
            ...command,
            payload: { commandId: row.id, type: row.type, delivery: 'exhausted' }
          };
          await this.deadLetterQueue.publish(safeCommand);
          await this.database
            .sql`update outbox_commands set status = 'dead_letter', claim_owner = null, claim_token = null, claim_expires_at = null where id = ${row.id} and status = 'claimed' and claim_token = ${row.claim_token}`;
          deadLettered += 1;
          this.reportDelivery(row, error, 'outbox_command_dead_lettered', 'dead_letter');
        } else {
          await this.database
            .sql`update outbox_commands set status = 'pending', available_at = now() + interval '1 second' * ${row.delivery_attempts}, claim_owner = null, claim_token = null, claim_expires_at = null where id = ${row.id} and status = 'claimed' and claim_token = ${row.claim_token}`;
          this.reportDelivery(row, error, 'outbox_command_delivery_retried', 'pending');
        }
      }
    }
    return { claimed: claimed.length, published, deadLettered };
  }

  /** Records the outcome of a failed publish so discarded and dead-lettered deliveries stay visible. */
  private reportDelivery(row: OutboxRow, error: unknown, event: string, status: string): void {
    const record = {
      event,
      correlationId: row.id,
      runId: row.run_id,
      attemptId: row.id,
      status,
      retryCount: Math.max(0, row.delivery_attempts - 1),
      errorName: error instanceof Error ? error.constructor.name : 'UnknownError',
      errorCode: 'OUTBOX_COMMAND_PUBLISH_FAILED'
    };
    if (status === 'published') this.telemetry.warn(record);
    else this.telemetry.error(record);
  }

  /** Marks a claimed command as published only when this dispatcher still owns its claim. */
  private async markPublished(row: OutboxRow): Promise<boolean> {
    const marked = await this.database
      .sql`update outbox_commands set status = 'published', published_at = now(), claim_owner = null, claim_token = null, claim_expires_at = null where id = ${row.id} and status = 'claimed' and claim_token = ${row.claim_token}`;
    return marked.count > 0;
  }

  /** A failed publish response is not evidence that BullMQ rejected the stable job ID. */
  private async inspectAcceptance(
    commandId: string
  ): Promise<'accepted' | 'rejected' | 'ambiguous'> {
    const inspector = this.commandQueue as CommandQueue & {
      inspect?: (id: string) => Promise<CommandInspection>;
    };
    if (inspector.inspect === undefined) return 'ambiguous';
    try {
      const inspection = await inspector.inspect(commandId);
      return inspection.state === 'missing' ? 'rejected' : 'accepted';
    } catch {
      return 'ambiguous';
    }
  }
}

/** Bounded, leaderless polling loop that can be stopped before process shutdown. */
export class OutboxDispatcherLoop {
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private running = false;
  private consecutiveFailures = 0;
  /** Configures bounded polling for the outbox dispatcher. */
  public constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly pollMs = 1_000,
    private readonly batchSize = 25,
    private readonly telemetry: Logger = logger
  ) {}
  /** Starts polling when the loop is not already active. */
  public start(): void {
    if (this.timer === undefined) void this.tick();
  }
  /** Stops future polling and waits for the active batch to finish. */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  /** Dispatches one batch and schedules the next poll with bounded failure backoff. */
  private async tick(): Promise<void> {
    this.running = true;
    const startedAt = Date.now();
    let delay = this.pollMs;
    try {
      await this.dispatcher.dispatchBatch(this.batchSize);
      this.consecutiveFailures = 0;
    } catch (error) {
      delay = Math.min(this.pollMs * 2, 30_000);
      this.consecutiveFailures += 1;
      reportLoopFailure(this.telemetry, {
        event: 'outbox_dispatcher_loop_failed',
        errorCode: 'OUTBOX_DISPATCH_LOOP_FAILED',
        error,
        durationMs: Date.now() - startedAt,
        consecutiveFailures: this.consecutiveFailures
      });
    } finally {
      this.running = false;
    }
    if (!this.stopping) this.timer = setTimeout(() => void this.tick(), delay);
  }
}
