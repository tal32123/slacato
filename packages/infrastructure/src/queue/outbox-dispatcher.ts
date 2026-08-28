import type { CommandQueue, WorkflowCommand } from '@slacato/core';
import type { DatabaseClient } from '../db/client.js';

type OutboxRow = Readonly<{ id: string; run_id: string; type: string; payload: Record<string, unknown>; idempotency_key: string; delivery_attempts: number; claim_token: string }>;

/** Multi-replica-safe outbox publisher: database claims are short; Redis I/O happens outside transactions. */
export class OutboxDispatcher {
  private readonly owner = `dispatcher_${crypto.randomUUID()}`;
  public constructor(private readonly database: DatabaseClient, private readonly commandQueue: CommandQueue, private readonly deadLetterQueue: CommandQueue, private readonly maxAttempts = 3, private readonly claimLeaseMs = 30_000) {}

  public async dispatchBatch(limit = 25): Promise<Readonly<{ claimed: number; published: number; deadLettered: number }>> {
    const claimToken = `outbox_claim_${crypto.randomUUID()}`;
    const claimed = await this.database.sql.begin(async (sql) => sql<OutboxRow[]>`
      with candidates as (
        select id from outbox_commands where (status = 'pending' and available_at <= now()) or (status = 'claimed' and claim_expires_at <= now()) order by available_at, id for update skip locked limit ${limit}
      )
      update outbox_commands command set status = 'claimed', claimed_at = now(), claim_owner = ${this.owner}, claim_token = ${claimToken}, claim_expires_at = now() + (${this.claimLeaseMs} * interval '1 millisecond'), delivery_attempts = command.delivery_attempts + 1
      from candidates where command.id = candidates.id
      returning command.id, command.run_id, command.type, command.payload, command.idempotency_key, command.delivery_attempts, command.claim_token
    `);
    let published = 0;
    let deadLettered = 0;
    for (const row of claimed) {
      const command: WorkflowCommand = { id: row.id, runId: row.run_id as WorkflowCommand['runId'], type: row.type, payload: row.payload, idempotencyKey: row.idempotency_key };
      try {
        await this.commandQueue.publish(command);
        const marked = await this.database.sql`update outbox_commands set status = 'published', published_at = now(), claim_owner = null, claim_token = null, claim_expires_at = null where id = ${row.id} and status = 'claimed' and claim_token = ${row.claim_token}`;
        if (marked.count > 0) published += 1;
      } catch (error) {
        if (row.delivery_attempts >= this.maxAttempts) {
          const safeCommand: WorkflowCommand = { ...command, payload: { commandId: row.id, type: row.type, delivery: 'exhausted' } };
          await this.deadLetterQueue.publish(safeCommand);
          await this.database.sql`update outbox_commands set status = 'dead_letter', claim_owner = null, claim_token = null, claim_expires_at = null where id = ${row.id} and status = 'claimed' and claim_token = ${row.claim_token}`;
          deadLettered += 1;
        } else {
          await this.database.sql`update outbox_commands set status = 'pending', available_at = now() + interval '1 second' * ${row.delivery_attempts}, claim_owner = null, claim_token = null, claim_expires_at = null where id = ${row.id} and status = 'claimed' and claim_token = ${row.claim_token}`;
        }
        void error;
      }
    }
    return { claimed: claimed.length, published, deadLettered };
  }
}

/** Bounded, leaderless polling loop that can be stopped before process shutdown. */
export class OutboxDispatcherLoop {
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private running = false;
  public constructor(private readonly dispatcher: OutboxDispatcher, private readonly pollMs = 1_000, private readonly batchSize = 25) {}
  public start(): void { if (this.timer === undefined) void this.tick(); }
  public async stop(): Promise<void> { this.stopping = true; if (this.timer !== undefined) clearTimeout(this.timer); while (this.running) await new Promise((resolve) => setTimeout(resolve, 10)); }
  private async tick(): Promise<void> {
    this.running = true;
    try { await this.dispatcher.dispatchBatch(this.batchSize); } finally { this.running = false; }
    if (!this.stopping) this.timer = setTimeout(() => void this.tick(), this.pollMs);
  }
}
