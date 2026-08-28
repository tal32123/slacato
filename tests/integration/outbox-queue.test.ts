import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandQueue, WorkflowCommand } from '@slacato/core';
import { createDatabaseClient } from '@slacato/infrastructure/db/client';
import { PostgresWorkflowStore } from '@slacato/infrastructure/db/repositories/workflow-store';
import { BullMqCommandQueue } from '@slacato/infrastructure/queue/bullmq';
import { OutboxDispatcher } from '@slacato/infrastructure/queue/outbox-dispatcher';
import { PostgresCommandReconciler } from '@slacato/infrastructure/queue/reconciler';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';
const database = createDatabaseClient(databaseUrl, 4);
const store = new PostgresWorkflowStore(database);
const queue = new BullMqCommandQueue(redisUrl, 'slacato-workflow-integration');

function suffix(): string { return crypto.randomUUID().replaceAll('-', ''); }
function command(runId: string, id = `command_${suffix()}`): WorkflowCommand {
  return { id, runId: runId as WorkflowCommand['runId'], type: 'process-step', payload: { step: 'start' }, idempotencyKey: id };
}
async function seedRun() {
  const id = suffix();
  const userId = `user_outbox_${id}`;
  const accountId = `account_outbox_${id}`;
  const opportunityId = `opportunity_outbox_${id}`;
  const runId = `run_outbox_${id}`;
  const raw = postgres(databaseUrl, { max: 1 });
  await raw`insert into personas (id, display_name, role) values (${userId}, 'Outbox user', 'seller')`;
  await raw`insert into accounts (id, name) values (${accountId}, 'Outbox account')`;
  await raw`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Outbox opportunity')`;
  await raw.end({ timeout: 1 });
  return { userId, opportunityId, runId };
}

beforeAll(async () => { await queue.queue.waitUntilReady(); });
afterAll(async () => { await queue.close(); await database.close(); });

describe('PostgreSQL outbox and workflow leases', () => {
  it('recovers a command committed before queue publication and suppresses duplicate BullMQ delivery', async () => {
    const seeded = await seedRun();
    const next = command(seeded.runId);
    await store.startRun({
      id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never,
      status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next
    });
    await store.startRun({
      id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never,
      status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next
    });
    expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('pending');
    expect((await database.sql<{ count: string }[]>`select count(*)::text as count from run_events where run_id = ${seeded.runId}`)[0]?.count).toBe('1');

    const first = new OutboxDispatcher(database, queue, queue);
    const second = new OutboxDispatcher(database, queue, queue);
    const outcomes = await Promise.all([first.dispatchBatch(), second.dispatchBatch()]);
    expect(outcomes.reduce((total, outcome) => total + outcome.published, 0)).toBe(1);
    expect(await queue.queue.getJob(next.id)).toBeDefined();
    await queue.publish(next);
    expect(await queue.queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBeGreaterThanOrEqual(1);
  });

  it('requeues an accepted publication lost from Redis when no lease is live', async () => {
    await database.sql`update outbox_commands set consumed_at = now() where status = 'published'`;
    const seeded = await seedRun();
    const next = command(seeded.runId);
    await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
    await new OutboxDispatcher(database, queue, queue).dispatchBatch();
    await queue.queue.remove(next.id);
    const restored = await new PostgresCommandReconciler(database, queue).reconcile();
    expect(restored).toBeGreaterThanOrEqual(1);
    expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('pending');
  });

  it('allows only expired leases to be taken over', async () => {
    const seeded = await seedRun();
    const start = command(seeded.runId);
    await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: start });
    const at = new Date('2026-08-28T12:00:00.000Z');
    const first = await store.claimStep({ runId: seeded.runId as never, step: 'llm', invocationId: `invocation_${suffix()}`, owner: 'worker-a', leaseMs: 1000, now: at });
    const blocked = await store.claimStep({ runId: seeded.runId as never, step: 'llm', invocationId: `invocation_${suffix()}`, owner: 'worker-b', leaseMs: 1000, now: new Date(at.getTime() + 500) });
    const takeover = await store.claimStep({ runId: seeded.runId as never, step: 'llm', invocationId: `invocation_${suffix()}`, owner: 'worker-b', leaseMs: 1000, now: new Date(at.getTime() + 1001) });
    expect(first?.owner).toBe('worker-a');
    expect(blocked).toBeUndefined();
    expect(takeover?.owner).toBe('worker-b');
    expect(takeover?.attempt).toBe(2);
    await expect(store.commitStepAndEnqueueNext({
      runId: seeded.runId as never, expectedVersion: 0, invocationId: first!.invocationId, invocationOwner: first!.owner, leaseToken: first!.leaseToken,
      event: 'start', checkpoint: {}, nextCommand: command(seeded.runId)
    })).rejects.toThrow('lease');
  });

  it('reclaims a dispatcher crash after database claim but before queue publication', async () => {
    const seeded = await seedRun();
    const next = command(seeded.runId);
    await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
    await database.sql`update outbox_commands set status = 'claimed', claim_owner = 'dead-dispatcher', claim_token = 'expired-claim', claim_expires_at = now() - interval '1 second' where id = ${next.id}`;
    const outcome = await new OutboxDispatcher(database, queue, queue).dispatchBatch();
    expect(outcome.published).toBeGreaterThanOrEqual(1);
    expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('published');
  });

  it('does not republish a terminal queue command after successful delivery', async () => {
    const seeded = await seedRun();
    const next = command(seeded.runId);
    await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
    await database.sql`update outbox_commands set status = 'published', published_at = now() where id = ${next.id}`;
    const reconciler = new PostgresCommandReconciler(database, { state: async () => 'terminal' });
    expect(await reconciler.reconcile()).toBe(0);
    expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('published');
  });

  it('rejects an approval subject owned by another run', async () => {
    const first = await seedRun();
    const second = await seedRun();
    const firstCommand = command(first.runId);
    const secondCommand = command(second.runId);
    await store.startRun({ id: first.runId as never, opportunityId: first.opportunityId as never, requestedBy: first.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: firstCommand });
    await store.startRun({ id: second.runId as never, opportunityId: second.opportunityId as never, requestedBy: second.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: secondCommand });
    const subjectId = `approval_subject_${suffix()}`;
    await database.sql`update runs set status = 'awaiting_approval', version = 5 where id in (${first.runId}, ${second.runId})`;
    await database.sql`insert into approval_subjects (id, run_id, draft_version, subject_hash) values (${subjectId}, ${first.runId}, 5, ${`hash_${suffix()}`})`;
    await expect(store.recordDecisionAndEnqueueFinalization({
      runId: second.runId as never, expectedVersion: 5, approvalSubjectId: subjectId, action: 'approve_unchanged', actorId: second.userId as never
    })).rejects.toThrow('Approval subject');
  });

  it('moves exhausted delivery to a redacted inspectable dead-letter queue', async () => {
    const seeded = await seedRun();
    const next = command(seeded.runId);
    await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
    const deadLetters: WorkflowCommand[] = [];
    const failingQueue: CommandQueue = { publish: async () => { throw new Error('redis unavailable'); } };
    const deadLetterQueue: CommandQueue = { publish: async (entry) => { deadLetters.push(entry); } };
    const outcome = await new OutboxDispatcher(database, failingQueue, deadLetterQueue, 1).dispatchBatch();
    expect(outcome.deadLettered).toBeGreaterThanOrEqual(1);
    expect(deadLetters).toContainEqual(expect.objectContaining({ id: next.id, payload: { commandId: next.id, type: 'process-step', delivery: 'exhausted' } }));
    expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('dead_letter');
  });
});
