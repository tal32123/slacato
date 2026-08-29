import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UnrecoverableError, Worker } from 'bullmq';
import type { CommandQueue, StartRunInput, WorkflowCommand } from '@slacato/core';
import { createDatabaseClient } from '@slacato/infrastructure/db/client';
import { PostgresWorkflowStore } from '@slacato/infrastructure/db/repositories/workflow-store';
import { BullMqCommandQueue } from '@slacato/infrastructure/queue/bullmq';
import { OutboxDispatcher } from '@slacato/infrastructure/queue/outbox-dispatcher';
import { PostgresCommandReconciler } from '@slacato/infrastructure/queue/reconciler';

const sourceDatabaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databaseName = `catohw_outbox_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
const databaseNamePattern = /^catohw_outbox_[a-z0-9]{16}$/;
function databaseUrlFor(name: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
const databaseUrl = databaseUrlFor(databaseName);
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';
const database = createDatabaseClient(databaseUrl, 4);
function budgetedStore(client: typeof database): PostgresWorkflowStore {
  const store = new PostgresWorkflowStore(client);
  return new Proxy(store, { get(target, property, receiver) {
    if (property === 'startRun') return (input: Omit<StartRunInput, 'budget'>) => target.startRun({ ...input, budget: { scope: input.id, maxCalls: 10, maxInputTokens: 10_000, maxOutputTokens: 10_000, deadlineMs: 1_000 } });
    return Reflect.get(target, property, receiver);
  } });
}
const store = budgetedStore(database);
const queue = new BullMqCommandQueue(redisUrl, `slacato-workflow-integration-${crypto.randomUUID()}`);
const seededRunIds: string[] = [];

function suffix(): string { return crypto.randomUUID().replaceAll('-', ''); }
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
  seededRunIds.push(runId);
  return { userId, opportunityId, runId };
}

async function createTemporaryDatabase(): Promise<void> {
  if (!databaseNamePattern.test(databaseName)) throw new Error(`Refusing to create non-test database ${databaseName}`);
  const maintenance = postgres(databaseUrlFor('postgres'), { max: 1 });
  try {
    await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end({ timeout: 1 });
  }
  const migrationFiles = (await readdir(resolve(process.cwd(), 'drizzle')))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  const target = postgres(databaseUrl, { max: 1 });
  try {
    for (const file of migrationFiles) await target.unsafe(await readFile(resolve(process.cwd(), 'drizzle', file), 'utf8'));
  } finally {
    await target.end({ timeout: 1 });
  }
}

async function dropTemporaryDatabase(): Promise<void> {
  if (!databaseNamePattern.test(databaseName)) throw new Error(`Refusing to drop non-test database ${databaseName}`);
  const maintenance = postgres(databaseUrlFor('postgres'), { max: 1 });
  try {
    await maintenance`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName} and pid <> pg_backend_pid()`;
    await maintenance.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await maintenance.end({ timeout: 1 });
  }
}

async function waitForFailedJob(commandQueue: BullMqCommandQueue, commandId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await commandQueue.queue.getJob(commandId);
    if (job !== undefined && await job.getState() === 'failed') return;
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${commandId} to exhaust`);
}

async function waitForCompletedJob(commandQueue: BullMqCommandQueue, commandId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await commandQueue.queue.getJob(commandId);
    if (job !== undefined && await job.getState() === 'completed') return;
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${commandId} to complete`);
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (check()) return;
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

beforeAll(async () => { await createTemporaryDatabase(); await queue.queue.waitUntilReady(); });
afterEach(async () => {
  const runIds = seededRunIds.splice(0);
  if (runIds.length === 0) return;
  await database.sql`update outbox_commands set consumed_at = now() where run_id in ${database.sql(runIds)}`;
  await database.sql`update runs set status = 'failed' where id in ${database.sql(runIds)}`;
});
afterAll(async () => {
  await queue.queue.obliterate({ force: true });
  await queue.close();
  await database.close();
  await dropTemporaryDatabase();
});

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
    expect(outcomes.reduce((total, outcome) => total + outcome.published, 0)).toBeGreaterThanOrEqual(1);
    expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('published');
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
    await database.sql`update outbox_commands set status = 'published', published_at = now() where id = ${start.id}`;
    const at = new Date('2026-08-28T12:00:00.000Z');
    const first = await store.claimStep({ runId: seeded.runId as never, step: 'llm', invocationId: `invocation_${suffix()}`, causalCommandId: start.id, owner: 'worker-a', leaseMs: 1000, now: at });
    const blocked = await store.claimStep({ runId: seeded.runId as never, step: 'llm', invocationId: `invocation_${suffix()}`, causalCommandId: start.id, owner: 'worker-b', leaseMs: 1000, now: new Date(at.getTime() + 500) });
    const takeover = await store.claimStep({ runId: seeded.runId as never, step: 'llm', invocationId: `invocation_${suffix()}`, causalCommandId: start.id, owner: 'worker-b', leaseMs: 1000, now: new Date(at.getTime() + 1001) });
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

  it('does not requeue a real completed and consumed command', async () => {
    const queueName = `slacato-workflow-completed-${suffix()}`;
    const completedQueue = new BullMqCommandQueue(redisUrl, queueName);
    const worker = new Worker(queueName, async () => undefined, { connection: { url: redisUrl } });
    await Promise.all([completedQueue.queue.waitUntilReady(), worker.waitUntilReady()]);
    const seeded = await seedRun();
    const next = command(seeded.runId);
    try {
      await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
      await new OutboxDispatcher(database, completedQueue, completedQueue).dispatchBatch();
      await waitForCompletedJob(completedQueue, next.id);
      await new PostgresCommandReconciler(database, completedQueue).markConsumed(next.id);

      await new PostgresCommandReconciler(database, completedQueue).reconcile();
      expect((await database.sql<{ status: string; consumed_at: string | null }[]>`select status, consumed_at from outbox_commands where id = ${next.id}`)[0]).toMatchObject({ status: 'published' });
      expect((await database.sql<{ consumed_at: string | null }[]>`select consumed_at from outbox_commands where id = ${next.id}`)[0]?.consumed_at).not.toBeNull();
    } finally {
      await worker.close(); await completedQueue.close();
    }
  });

  it('rejects incomplete completed-job recovery capabilities before claiming the outbox row', async () => {
    const queueName = `slacato-workflow-incomplete-recovery-${suffix()}`;
    const primary = new BullMqCommandQueue(redisUrl, queueName);
    const worker = new Worker(queueName, async () => undefined, { connection: { url: redisUrl } });
    await Promise.all([primary.queue.waitUntilReady(), worker.waitUntilReady()]);
    try {
      const seeded = await seedRun(); const next = command(seeded.runId);
      await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next, idempotencyKey: next.idempotencyKey, startRequestHash: `hash_${suffix()}` });
      await new OutboxDispatcher(database, primary, primary).dispatchBatch();
      await waitForCompletedJob(primary, next.id);

      const incomplete = { state: primary.state.bind(primary) };
      expect(() => new PostgresCommandReconciler(database, incomplete as never)).toThrow('state, reopenCompleted, and publish');
      expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('published');
    } finally {
      await worker.close(); await primary.close();
    }
  });

  it('reopens a retained completed but unconsumed primary job and executes the stable command again', async () => {
    const queueName = `slacato-workflow-completed-unconsumed-${suffix()}`;
    const primary = new BullMqCommandQueue(redisUrl, queueName);
    let executions = 0;
    const worker = new Worker(queueName, async () => { executions += 1; return {}; }, { connection: { url: redisUrl } });
    await Promise.all([primary.queue.waitUntilReady(), worker.waitUntilReady()]);
    try {
      const seeded = await seedRun(); const next = command(seeded.runId);
      await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next, idempotencyKey: next.idempotencyKey, startRequestHash: `hash_${suffix()}` });
      await new OutboxDispatcher(database, primary, primary).dispatchBatch();
      await waitForCompletedJob(primary, next.id);
      const executionsBeforeRecovery = executions;

      const restored = await new PostgresCommandReconciler(database, primary).reconcile();

      expect(restored).toBeGreaterThanOrEqual(1);
      await waitFor(() => executions > executionsBeforeRecovery, 'the reopened completed command to execute');
      expect((await database.sql<{ status: string; consumed_at: string | null }[]>`select status, consumed_at from outbox_commands where id = ${next.id}`)[0]).toMatchObject({ status: 'published', consumed_at: null });
      expect((await primary.queue.getJob(next.id))?.data.id).toBe(next.id);
    } finally {
      await worker.close(); await primary.close();
    }
  });

  it('recovers a crash after completed-job removal but before republication', async () => {
    const queueName = `slacato-workflow-completed-recovery-crash-${suffix()}`;
    const primary = new BullMqCommandQueue(redisUrl, queueName);
    let executions = 0;
    const worker = new Worker(queueName, async () => { executions += 1; return {}; }, { connection: { url: redisUrl } });
    await Promise.all([primary.queue.waitUntilReady(), worker.waitUntilReady()]);
    try {
      const seeded = await seedRun(); const next = command(seeded.runId);
      await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next, idempotencyKey: next.idempotencyKey, startRequestHash: `hash_${suffix()}` });
      await new OutboxDispatcher(database, primary, primary).dispatchBatch();
      await waitForCompletedJob(primary, next.id);
      const executionsBeforeRecovery = executions;

      const crashAfterRemoval = {
        inspect: primary.inspect.bind(primary),
        state: primary.state.bind(primary),
        reopenCompleted: async (commandId: string) => { await primary.reopenCompleted(commandId); throw new Error('simulated crash after completed-job removal'); },
        publish: primary.publish.bind(primary)
      };
      await expect(new PostgresCommandReconciler(database, crashAfterRemoval).reconcile()).rejects.toThrow('simulated crash after completed-job removal');
      expect(await primary.queue.getJob(next.id)).toBeUndefined();
      expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('claimed');

      await new PostgresCommandReconciler(database, primary).reconcile();
      await waitFor(() => executions > executionsBeforeRecovery, 'the recovered command to execute');
      expect((await primary.queue.getJob(next.id))?.data.id).toBe(next.id);
    } finally {
      await worker.close(); await primary.close();
    }
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
      runId: second.runId as never, expectedVersion: 5, approvalSubjectId: subjectId, action: 'approve_unchanged', actorId: second.userId as never, finalizationCommand: command(second.runId)
    })).rejects.toThrow('Approval subject');
  });

  it('moves exhausted delivery to a redacted inspectable dead-letter queue', async () => {
    const seeded = await seedRun();
    const next = command(seeded.runId);
    await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
    const deadLetters: WorkflowCommand[] = [];
    const failingQueue = { publish: async () => { throw new Error('redis unavailable'); }, inspect: async () => ({ state: 'missing' as const, attemptsMade: 0, maxAttempts: 0, exhausted: false }) };
    const deadLetterQueue: CommandQueue = { publish: async (entry) => { deadLetters.push(entry); } };
    const outcome = await new OutboxDispatcher(database, failingQueue, deadLetterQueue, 1).dispatchBatch();
    expect(outcome.deadLettered).toBeGreaterThanOrEqual(1);
    expect(deadLetters).toContainEqual(expect.objectContaining({ id: next.id, payload: { commandId: next.id, type: 'process-step', delivery: 'exhausted' } }));
    expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('dead_letter');
  });

  it('accepts a primary job when publication throws after BullMQ acceptance without dead-lettering it', async () => {
    const queueName = `slacato-workflow-accept-then-throw-${suffix()}`;
    const primary = new BullMqCommandQueue(redisUrl, queueName);
    const deadLetters: WorkflowCommand[] = [];
    const acceptThenThrow = {
      publish: async (entry: WorkflowCommand) => { await primary.publish(entry); throw new Error('simulated response loss after BullMQ acceptance'); },
      inspect: primary.inspect.bind(primary)
    };
    const deadLetterQueue: CommandQueue = { publish: async (entry) => { deadLetters.push(entry); } };
    await primary.queue.waitUntilReady();
    try {
      const seeded = await seedRun(); const next = command(seeded.runId);
      await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });

      const outcome = await new OutboxDispatcher(database, acceptThenThrow, deadLetterQueue, 1).dispatchBatch();

      expect(outcome).toMatchObject({ published: 1, deadLettered: 0 });
      expect(deadLetters).toEqual([]);
      expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('published');
      expect(await primary.queue.getJob(next.id)).toBeDefined();
    } finally {
      await primary.close();
    }
  });

  it('leaves an ambiguous primary publication claim recoverable when inspection also fails', async () => {
    const seeded = await seedRun(); const next = command(seeded.runId);
    await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
    const deadLetters: WorkflowCommand[] = [];
    const unavailable = {
      publish: async () => { throw new Error('primary unavailable'); },
      inspect: async () => { throw new Error('primary inspection unavailable'); }
    };
    const deadLetterQueue: CommandQueue = { publish: async (entry) => { deadLetters.push(entry); } };

    const outcome = await new OutboxDispatcher(database, unavailable, deadLetterQueue, 1, 1).dispatchBatch();

    expect(outcome).toMatchObject({ published: 0, deadLettered: 0 });
    expect(deadLetters).toEqual([]);
    expect((await database.sql<{ status: string; delivery_attempts: number }[]>`select status, delivery_attempts from outbox_commands where id = ${next.id}`)[0]).toEqual({ status: 'claimed', delivery_attempts: 0 });
    await pause(5);
    const primary = new BullMqCommandQueue(redisUrl, `slacato-workflow-ambiguous-retry-${suffix()}`);
    await primary.queue.waitUntilReady();
    try {
      await new OutboxDispatcher(database, primary, primary, 1).dispatchBatch();
      expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('published');
    } finally {
      await primary.close();
    }
  });

  it('moves a real exhausted processor failure out of the primary outbox', async () => {
    const queueName = `slacato-workflow-exhausted-${suffix()}`;
    const failedQueue = new BullMqCommandQueue(redisUrl, queueName);
    const deadLetters = new BullMqCommandQueue(redisUrl, `${queueName}-dead-letter`);
    const worker = new Worker(queueName, async () => { throw new Error('provider credential leaked: secret-value'); }, { connection: { url: redisUrl } });
    await failedQueue.queue.waitUntilReady();
    await deadLetters.queue.waitUntilReady();
    await worker.waitUntilReady();
    try {
      const seeded = await seedRun();
      const next = { ...command(seeded.runId), payload: { providerSecret: 'secret-value', step: 'start' } };
      await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
      await new OutboxDispatcher(database, failedQueue, failedQueue).dispatchBatch();
      await waitForFailedJob(failedQueue, next.id);

      expect(await failedQueue.inspect(next.id)).toMatchObject({ state: 'failed', attemptsMade: 3, maxAttempts: 3, exhausted: true });
      await new PostgresCommandReconciler(database, failedQueue, deadLetters).reconcile();

      expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('dead_letter');
      const record = await deadLetters.queue.getJob(next.id);
      expect(record?.data).toEqual({
        id: next.id,
        runId: seeded.runId,
        type: 'process-step',
        idempotencyKey: next.id,
        payload: { commandId: next.id, type: 'process-step', reason: 'processor_attempts_exhausted', attemptsMade: 3, maxAttempts: 3 }
      });
      expect(JSON.stringify(record?.data)).not.toContain('secret-value');
    } finally {
      await worker.close();
      await deadLetters.close();
      await failedQueue.close();
    }
  });

  it('does not retry a BullMQ unrecoverable failure below its configured attempt limit', async () => {
    const queueName = `slacato-workflow-unrecoverable-${suffix()}`;
    const failedQueue = new BullMqCommandQueue(redisUrl, queueName);
    const deadLetters = new BullMqCommandQueue(redisUrl, `${queueName}-dead-letter`);
    const worker = new Worker(queueName, async () => { throw new UnrecoverableError('safe processor category only'); }, { connection: { url: redisUrl } });
    await failedQueue.queue.waitUntilReady();
    await deadLetters.queue.waitUntilReady();
    await worker.waitUntilReady();
    try {
      const seeded = await seedRun();
      const next = command(seeded.runId);
      await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
      await new OutboxDispatcher(database, failedQueue, failedQueue).dispatchBatch();
      await waitForFailedJob(failedQueue, next.id);

      expect(await failedQueue.inspect(next.id)).toMatchObject({ state: 'failed', attemptsMade: 1, maxAttempts: 3, exhausted: true });
      await new PostgresCommandReconciler(database, failedQueue, deadLetters).reconcile();

      expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('dead_letter');
    } finally {
      await worker.close();
      await deadLetters.close();
      await failedQueue.close();
    }
  });

  it('recovers a crash after its durable DLQ claim but before DLQ publication', async () => {
    const queueName = `slacato-workflow-dlq-claim-crash-${suffix()}`;
    const primary = new BullMqCommandQueue(redisUrl, queueName);
    const deadLetters = new BullMqCommandQueue(redisUrl, `${queueName}-dead-letter`);
    const worker = new Worker(queueName, async () => { throw new Error('provider unavailable'); }, { connection: { url: redisUrl } });
    await Promise.all([primary.queue.waitUntilReady(), deadLetters.queue.waitUntilReady(), worker.waitUntilReady()]);
    try {
      const seeded = await seedRun(); const next = command(seeded.runId);
      await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
      await new OutboxDispatcher(database, primary, primary).dispatchBatch();
      await waitForFailedJob(primary, next.id);
      const crashBeforePublish: CommandQueue = { publish: async () => { throw new Error('simulated DLQ process crash'); } };

      await expect(new PostgresCommandReconciler(database, primary, crashBeforePublish).reconcile()).rejects.toThrow('simulated DLQ process crash');
      expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('dead_letter_claimed');
      expect(await deadLetters.queue.getJob(next.id)).toBeUndefined();

      await new PostgresCommandReconciler(database, primary, deadLetters).reconcile();
      expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('dead_letter');
      expect(await deadLetters.queue.getJob(next.id)).toBeDefined();
    } finally {
      await worker.close(); await deadLetters.close(); await primary.close();
    }
  });

  it('acknowledges an already accepted stable DLQ job after a crash before the database ack', async () => {
    const queueName = `slacato-workflow-dlq-ack-crash-${suffix()}`;
    const primary = new BullMqCommandQueue(redisUrl, queueName);
    const deadLetters = new BullMqCommandQueue(redisUrl, `${queueName}-dead-letter`);
    const worker = new Worker(queueName, async () => { throw new Error('provider unavailable'); }, { connection: { url: redisUrl } });
    await Promise.all([primary.queue.waitUntilReady(), deadLetters.queue.waitUntilReady(), worker.waitUntilReady()]);
    try {
      const seeded = await seedRun(); const next = command(seeded.runId);
      await store.startRun({ id: seeded.runId as never, opportunityId: seeded.opportunityId as never, requestedBy: seeded.userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-chat', command: next });
      await new OutboxDispatcher(database, primary, primary).dispatchBatch();
      await waitForFailedJob(primary, next.id);
      const crashAfterPublish: CommandQueue = { publish: async (entry) => { await deadLetters.publish(entry); throw new Error('simulated crash after accepted DLQ job'); } };

      await expect(new PostgresCommandReconciler(database, primary, crashAfterPublish).reconcile()).rejects.toThrow('simulated crash after accepted DLQ job');
      expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('dead_letter_claimed');
      expect(await deadLetters.queue.getJob(next.id)).toBeDefined();

      await new PostgresCommandReconciler(database, primary, deadLetters).reconcile();
      expect((await database.sql<{ status: string }[]>`select status from outbox_commands where id = ${next.id}`)[0]?.status).toBe('dead_letter');
      expect(await deadLetters.queue.getJobCountByTypes('waiting', 'active', 'delayed', 'completed', 'failed')).toBe(1);
    } finally {
      await worker.close(); await deadLetters.close(); await primary.close();
    }
  });
});
