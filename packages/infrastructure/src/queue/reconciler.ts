import type { DatabaseClient } from '../db/client.js';

export interface LiveCommandInspector { state(commandId: string): Promise<'live' | 'terminal' | 'missing'>; }

/** Repairs Redis-loss ambiguity by returning stranded, nonterminal commands to the PostgreSQL outbox. */
export class PostgresCommandReconciler {
  public constructor(private readonly database: DatabaseClient, private readonly commands: LiveCommandInspector) {}
  public async reconcile(limit = 25): Promise<number> {
    const rows = await this.database.sql<{ id: string }[]>`
      select command.id from outbox_commands command join runs run on run.id = command.run_id
      where command.status = 'published' and command.consumed_at is null and run.status not in ('completed', 'rejected', 'failed')
      and not exists (select 1 from step_invocations invocation where invocation.run_id = run.id and invocation.status = 'leased' and invocation.lease_expires_at > now())
      order by command.published_at nulls first limit ${limit}
    `;
    let restored = 0;
    for (const row of rows) {
      if ((await this.commands.state(row.id)) === 'missing') {
        const result = await this.database.sql`update outbox_commands set status = 'pending', available_at = now(), claimed_at = null where id = ${row.id} and status = 'published'`;
        if (result.count > 0) restored += 1;
      }
    }
    return restored;
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
  public constructor(private readonly reconciler: PostgresCommandReconciler, private readonly pollMs = 5_000, private readonly batchSize = 25) {}
  public start(): void { if (this.timer === undefined) void this.tick(); }
  public async stop(): Promise<void> { this.stopping = true; if (this.timer !== undefined) clearTimeout(this.timer); while (this.running) await new Promise((resolve) => setTimeout(resolve, 10)); }
  private async tick(): Promise<void> {
    this.running = true;
    try { await this.reconciler.reconcile(this.batchSize); } finally { this.running = false; }
    if (!this.stopping) this.timer = setTimeout(() => void this.tick(), this.pollMs);
  }
}
