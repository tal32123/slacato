import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { hashApprovalPayload, type StartRunInput, type WorkflowCommand } from '@slacato/core';
import { createDatabaseClient } from '@slacato/infrastructure/db/client';
import { PostgresWorkflowStore } from '@slacato/infrastructure/db/repositories/workflow-store';
import { OutboxDispatcherLoop } from '@slacato/infrastructure/queue/outbox-dispatcher';
import { PostgresCommandReconciler } from '@slacato/infrastructure/queue/reconciler';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const database = createDatabaseClient(databaseUrl, 3);
function budgetedStore(client: typeof database): PostgresWorkflowStore {
  const store = new PostgresWorkflowStore(client);
  return new Proxy(store, { get(target, property, receiver) {
    if (property === 'startRun') return (input: Omit<StartRunInput, 'budget'>) => target.startRun({ ...input, budget: { scope: input.id, maxCalls: 10, deadlineMs: 1_000 } });
    return Reflect.get(target, property, receiver);
  } });
}
const store = budgetedStore(database);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function id(prefix: string): string { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
function command(runId: string, commandId = id('command')): WorkflowCommand { return { id: commandId, runId: runId as WorkflowCommand['runId'], type: 'process', payload: { step: 'start' }, idempotencyKey: commandId }; }
async function seededRun() {
  const userId = id('user'); const accountId = id('account'); const opportunityId = id('opportunity'); const runId = id('run');
  const sql = postgres(databaseUrl, { max: 1 });
  await sql`insert into personas (id, display_name, role) values (${userId}, 'Recovery user', 'seller')`;
  await sql`insert into accounts (id, name) values (${accountId}, 'Recovery account')`;
  await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Recovery opportunity')`;
  await sql.end({ timeout: 1 });
  return { userId, opportunityId, runId };
}

afterAll(async () => { await database.close(); });

describe('durable recovery regressions', () => {
  it('requeues a failed queue job instead of treating it as completed', async () => {
    const run = await seededRun(); const next = command(run.runId);
    await store.startRun({ id: run.runId as never, opportunityId: run.opportunityId as never, requestedBy: run.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next, idempotencyKey: next.idempotencyKey, startRequestHash: id('hash') });
    await database.sql`update outbox_commands set status = 'published', published_at = now() where id = ${next.id}`;
    const reconciler = new PostgresCommandReconciler(database, {
      state: async () => 'failed' as never,
      reopenCompleted: async () => { throw new Error('Unexpected completed command'); },
      publish: async () => { throw new Error('Unexpected command publication'); }
    });
    expect(await reconciler.reconcile()).toBeGreaterThanOrEqual(1);
    expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('pending');
  });

  it('keeps polling after one transient dispatcher failure and stops cleanly', async () => {
    let calls = 0;
    const loop = new OutboxDispatcherLoop({ dispatchBatch: async () => { calls += 1; if (calls === 1) throw new Error('temporary database outage'); return { claimed: 0, published: 0, deadLettered: 0 }; } } as never, 5, 1);
    loop.start();
    await pause(35);
    await loop.stop();
    const stoppedAt = calls;
    await pause(20);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBe(stoppedAt);
  });

  it('rejects a command that injects another run into startRun', async () => {
    const first = await seededRun(); const second = await seededRun();
    await expect(store.startRun({ id: first.runId as never, opportunityId: first.opportunityId as never, requestedBy: first.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', idempotencyKey: id('start'), startRequestHash: id('hash'), command: command(second.runId) })).rejects.toThrow('Run, command, and budget scopes do not match');
  });

  it('does not allow one published command to lease two different steps', async () => {
    const run = await seededRun(); const next = command(run.runId);
    await store.startRun({ id: run.runId as never, opportunityId: run.opportunityId as never, requestedBy: run.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', idempotencyKey: next.idempotencyKey, startRequestHash: id('hash'), command: next });
    await database.sql`update outbox_commands set status = 'published', published_at = now() where id = ${next.id}`;
    const first = await store.claimStep({ runId: run.runId as never, step: 'retrieve', invocationId: id('invocation'), causalCommandId: next.id, owner: 'a', leaseMs: 10_000 });
    const second = await store.claimStep({ runId: run.runId as never, step: 'synthesize', invocationId: id('invocation'), causalCommandId: next.id, owner: 'b', leaseMs: 10_000 });
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it('consumes and completes the causal lease at the approval boundary', async () => {
    const run = await seededRun(); const next = command(run.runId);
    await store.startRun({ id: run.runId as never, opportunityId: run.opportunityId as never, requestedBy: run.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', idempotencyKey: next.idempotencyKey, startRequestHash: id('hash'), command: next });
    await database.sql`update runs set status = 'validating' where id = ${run.runId}`;
    await database.sql`update outbox_commands set status = 'published', published_at = now() where id = ${next.id}`;
    const lease = await store.claimStep({ runId: run.runId as never, step: 'validate', invocationId: id('invocation'), causalCommandId: next.id, owner: 'worker', leaseMs: 10_000 });
    if (lease === undefined) throw new Error('Expected lease');
    const payload = {};
    await store.awaitApproval({
      runId: run.runId as never, expectedVersion: 0, invocationId: lease.invocationId, invocationOwner: lease.owner,
      leaseToken: lease.leaseToken, causalCommandId: next.id,
      subject: {
        id: id('subject'), runId: run.runId as never, subjectHash: hashApprovalPayload(payload), payload,
        sectionIds: [], recommendationIds: [], citationIds: [], policyTriggers: ['test'],
        quorumVersion: 'deal-brief-approval-v1',
        entries: [{ id: id('entry'), category: 'evidence_review', eligibleAuthorities: ['account_owner'], policyTriggers: ['test'], dependsOn: [] }]
      }
    });
    expect((await database.sql<{ status: string; consumed_at: string | null }[]>`select command.status, command.consumed_at from outbox_commands command where id = ${next.id}`)[0]?.consumed_at).not.toBeNull();
    expect((await database.sql<{ status: string }[]>`select status from step_invocations where id = ${lease.invocationId}`)[0]?.status).toBe('completed');
  });

  it('serializes concurrent idempotency-key replays without duplicate events', async () => {
    const run = await seededRun(); const stable = command(run.runId, id('command'));
    const input = { id: run.runId as never, opportunityId: run.opportunityId as never, requestedBy: run.userId as never, status: 'created' as const, generationProvider: 'mock', generationModel: 'mock-chat', idempotencyKey: stable.idempotencyKey, startRequestHash: id('hash'), command: stable };
    await Promise.all([store.startRun(input), store.startRun(input)]);
    expect((await database.sql<{ count: string }[]>`select count(*)::text as count from run_events where run_id = ${run.runId}`)[0]?.count).toBe('1');
  });
});
