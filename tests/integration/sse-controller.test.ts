import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgresDealBriefAccessControl,
  PostgresEventStore,
  PostgresRunEventQuery,
  PostgresWorkflowStore,
  createDatabaseClient,
  type DatabaseClient
} from '@slacato/infrastructure';
import {
  dealBriefSchema,
  hashApprovalPayload,
  StartDealBrief,
  type RunEvent,
  type StepLease,
  type WorkflowCommand
} from '@slacato/core';
import type { RunEventEnvelope, RunEventToPublish } from '@slacato/contracts';
import { configureApiApplication } from '../../apps/api/src/main';
import { AuthModule } from '../../apps/api/src/modules/auth/auth.module';
import type { AuthModuleOptions } from '../../apps/api/src/modules/auth/contracts';
import { RunsModule } from '../../apps/api/src/modules/runs/runs.module';
import type { WorkflowApiOptions } from '../../apps/api/src/modules/runs/contracts';

const adminUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databaseName = `slacato_sse_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
const origin = 'http://127.0.0.1:4173';
const timestamp = '2026-08-29T12:00:00.000Z';
const maya = { userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner', grants: [] };
const stranger = { userId: 'USR-5002', displayName: 'No Access', role: 'Account Owner', grants: [] };

class SseTestModule {}

function sseTestModule(auth: AuthModuleOptions, workflow: WorkflowApiOptions): DynamicModule {
  return { module: SseTestModule, imports: [AuthModule.register(auth), RunsModule.register(workflow)] };
}

type OpenStream = Readonly<{
  request: ClientRequest;
  response: IncomingMessage;
  headers: IncomingHttpHeaders;
  text: () => string;
  waitFor: (pattern: RegExp) => Promise<string>;
  ended: Promise<string>;
}>;

let database: DatabaseClient;
let publisherDatabase: DatabaseClient;
let publisher: PostgresEventStore;
let app: NestExpressApplication;
let baseUrl: URL;
let mayaCookie: string;
let strangerCookie: string;
const replicas: NestExpressApplication[] = [];
const replicaStores: PostgresEventStore[] = [];

function workflowOptions(store: PostgresEventStore, heartbeatMs = 25): WorkflowApiOptions {
  return {
    startDealBrief: { execute: async () => 'unused' } as never,
    regenerateDealBrief: { execute: async () => 'unused' } as never,
    decideApproval: { execute: async () => ({}) } as never,
    runEvents: { bus: store, query: new PostgresRunEventQuery(database), heartbeatMs }
  };
}

async function createReplica(heartbeatMs = 25): Promise<NestExpressApplication> {
  const store = new PostgresEventStore(database);
  replicaStores.push(store);
  const replica = await NestFactory.create<NestExpressApplication>(sseTestModule({
    sessionSecret: 'task-10-sse-test-secret-which-is-long-enough',
    environment: 'test',
    allowedOrigins: [origin],
    personaDirectory: {
      list: async () => [maya, stranger],
      findById: async (userId: string) => [maya, stranger].find((persona) => persona.userId === userId)
    }
  }, workflowOptions(store, heartbeatMs)), { logger: false, bodyParser: false });
  configureApiApplication(replica);
  await replica.listen(0, '127.0.0.1');
  replicas.push(replica);
  return replica;
}

async function login(server: NestExpressApplication, userId: string): Promise<string> {
  const bootstrap = await request(server.getHttpServer()).get('/api/auth/csrf').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(200);
  const seed = (bootstrap.headers['set-cookie'] as string[]).find((cookie) => cookie.startsWith('slacato_csrf_seed='))!.split(';')[0]!;
  const selected = await request(server.getHttpServer()).post('/api/auth/persona')
    .set('Origin', origin).set('Sec-Fetch-Site', 'same-site').set('Cookie', seed)
    .set('X-CSRF-Token', bootstrap.body.csrfToken as string).send({ userId }).expect(201);
  return (selected.headers['set-cookie'] as string[]).find((cookie) => cookie.startsWith('slacato_session='))!.split(';')[0]!;
}

function openStream(url: URL, path: string, cookie: string, headers: Readonly<Record<string, string>> = {}): Promise<OpenStream> {
  const opened = Promise.withResolvers<OpenStream>();
  const ended = Promise.withResolvers<string>();
  let body = '';
  const clientRequest = httpRequest(new URL(path, url), {
    method: 'GET',
    headers: { Cookie: cookie, Origin: origin, 'Sec-Fetch-Site': 'same-site', ...headers }
  }, (response) => {
    const waiters: Array<Readonly<{ pattern: RegExp; resolve: (text: string) => void }>> = [];
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      body += chunk;
      for (const waiter of waiters) if (waiter.pattern.test(body)) waiter.resolve(body);
    });
    response.on('end', () => ended.resolve(body));
    opened.resolve({
      request: clientRequest,
      response,
      headers: response.headers,
      text: () => body,
      waitFor: (pattern) => {
        if (pattern.test(body)) return Promise.resolve(body);
        const matched = Promise.withResolvers<string>();
        waiters.push({ pattern, resolve: matched.resolve });
        return matched.promise;
      },
      ended: ended.promise
    });
  });
  clientRequest.on('error', opened.reject);
  clientRequest.end();
  return opened.promise;
}

function event(id: string, streamId: string, type: string, payload: Readonly<Record<string, unknown>>): RunEventToPublish {
  const common = { id, streamId, type, version: 1, timestamp };
  if (type === 'complete') {
    return { ...common, payload: { version: 1, subjectHash: 'f'.repeat(64), deterministic: true, terminal: true } } as RunEventToPublish;
  }
  if (type === 'progress') return { ...common, payload: { status: payload.status } } as RunEventToPublish;
  return { ...common, payload: { version: 1, status: payload.status } } as RunEventToPublish;
}

async function seedRuns(): Promise<void> {
  await database.sql`insert into personas (id, display_name, role) values
    (${maya.userId}, ${maya.displayName}, ${maya.role}), (${stranger.userId}, ${stranger.displayName}, ${stranger.role})`;
  await database.sql`insert into accounts (id, name) values ('ACC-SSE', 'SSE Account')`;
  await database.sql`insert into opportunities (id, account_id, name) values ('OPP-SSE', 'ACC-SSE', 'SSE Opportunity')`;
  await database.sql`insert into permission_grants (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing)
    values ('grant-sse', ${maya.userId}, 'ACC-SSE', 'salesforce', true, false, true, false, false)`;
  await database.sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash)
    values ('run-sse', 'OPP-SSE', ${maya.userId}, 'retrieving', 'mock', 'mock-brief', ${'a'.repeat(64)}),
      ('run-other', 'OPP-SSE', ${maya.userId}, 'completed', 'mock', 'mock-brief', ${'b'.repeat(64)})`;
}

beforeAll(async () => {
  await admin.unsafe(`create database "${databaseName}"`);
  database = createDatabaseClient(databaseUrl.toString(), 12);
  publisherDatabase = createDatabaseClient(databaseUrl.toString(), 3);
  await migrate(drizzle(database.sql), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  publisher = new PostgresEventStore(publisherDatabase);
  app = await createReplica();
  baseUrl = new URL(await app.getUrl());
  mayaCookie = await login(app, maya.userId);
  strangerCookie = await login(app, stranger.userId);
});

beforeEach(async () => {
  await database.sql`truncate table audit_events, trace_spans, run_events, runs, permission_grants, opportunities, accounts, personas cascade`;
  await seedRuns();
});

afterAll(async () => {
  await Promise.all(replicas.splice(0).map((replica) => replica.close()));
  await Promise.all(replicaStores.splice(0).map((store) => store.close()));
  await publisher.close();
  await publisherDatabase.close();
  await database.close();
  await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await admin.end({ timeout: 5 });
});

describe.sequential('authorized raw run SSE', () => {
  it('returns a snapshot watermark, closes the snapshot race by replay, and emits exact proxy-safe framing through terminal close', async () => {
    await publisher.publish(event('evt-1', 'run-sse', 'retrieval_completed', { status: 'specialists_running' }));
    const snapshot = await request(app.getHttpServer()).get('/api/runs/run-sse')
      .set('Cookie', mayaCookie).set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(200);
    expect(snapshot.body).toEqual({ streamId: 'run-sse', status: 'retrieving', version: 0, watermark: 'evt-1', terminal: false });

    await publisher.publish(event('evt-2', 'run-sse', 'specialists_completed', { status: 'synthesizing' }));
    await publisher.publish(event('evt-3', 'run-sse', 'complete', { status: 'completed', terminal: true }));
    const stream = await openStream(baseUrl, '/api/runs/run-sse/events?after=evt-1', mayaCookie);
    const body = await stream.ended;

    expect(stream.response.statusCode).toBe(200);
    expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers['cache-control']).toBe('no-cache, no-transform');
    expect(stream.headers.connection).toBe('keep-alive');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    expect(body).not.toContain('id: evt-1');
    expect(body).toContain('id: evt-2\nevent: specialists_completed\ndata: ');
    expect(body).toContain('id: evt-3\nevent: complete\ndata: ');
    expect(body.match(/\n\n/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('gives a validated Last-Event-ID header precedence over the reload query cursor', async () => {
    await publisher.publish(event('evt-1', 'run-sse', 'progress', { status: 'retrieving' }));
    await publisher.publish(event('evt-2', 'run-sse', 'progress', { status: 'validating' }));
    await publisher.publish(event('evt-3', 'run-sse', 'complete', { status: 'completed', terminal: true }));

    const stream = await openStream(baseUrl, '/api/runs/run-sse/events?after=evt-1', mayaCookie, { 'Last-Event-ID': 'evt-2' });
    const body = await stream.ended;
    expect(body).not.toContain('id: evt-1');
    expect(body).not.toContain('id: evt-2');
    expect(body).toContain('id: evt-3');

    await request(app.getHttpServer()).get('/api/runs/run-sse/events?after=evt-1')
      .set('Cookie', mayaCookie).set('Origin', origin).set('Sec-Fetch-Site', 'same-site')
      .set('Last-Event-ID', 'bad cursor with spaces').expect(400);
    await request(app.getHttpServer()).get('/api/runs/run-sse/events?after=evt-1&after=evt-2')
      .set('Cookie', mayaCookie).set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(400);
  });

  it('deduplicates repeated wakeups and never emits another run stream', async () => {
    await publisher.publish(event('evt-1', 'run-sse', 'progress', { status: 'retrieving' }));
    const stream = await openStream(baseUrl, '/api/runs/run-sse/events?after=evt-1', mayaCookie);
    await publisher.publish(event('evt-other', 'run-other', 'complete', { status: 'completed', terminal: true }));
    await publisher.publish(event('evt-2', 'run-sse', 'complete', { status: 'completed', terminal: true }));
    await publisherDatabase.sql`select pg_notify('slacato_run_events', 'run-sse'), pg_notify('slacato_run_events', 'run-sse')`;
    const body = await stream.ended;

    expect(body).not.toContain('evt-other');
    expect(body.match(/id: evt-2/g)).toHaveLength(1);
  });

  it('polls PostgreSQL as the authority when a durable event has no notification wakeup', async () => {
    await publisher.publish(event('evt-1', 'run-sse', 'progress', { status: 'retrieving' }));
    const stream = await openStream(baseUrl, '/api/runs/run-sse/events?after=evt-1', mayaCookie);
    await publisherDatabase.sql`insert into run_events (id, run_id, sequence, type, version, payload, created_at)
      select 'evt-without-notify', 'run-sse', max(sequence) + 1, 'progress', 1, '{"status":"validating"}'::jsonb, now()
      from run_events where run_id = 'run-sse'`;

    await expect(stream.waitFor(/id: evt-without-notify/)).resolves.toContain('event: progress');
    await publisher.publish(event('evt-terminal', 'run-sse', 'complete', { status: 'completed', terminal: true }));
    const body = await stream.ended;
    expect(body.indexOf('id: evt-without-notify')).toBeLessThan(body.indexOf('id: evt-terminal'));
  });

  it('emits a typed resync instruction without an SSE id when a valid cursor is no longer available', async () => {
    const stream = await openStream(baseUrl, '/api/runs/run-sse/events?after=evt-expired', mayaCookie);
    const body = await stream.ended;

    expect(stream.response.statusCode).toBe(200);
    expect(body).toContain('event: stream.resync_required');
    expect(body).toContain('"reason":"cursor_expired"');
    expect(body).toContain('"snapshotPath":"/api/runs/run-sse"');
    expect(body).not.toMatch(/^id:/m);
  });

  it('keeps inaccessible and absent runs opaque and writes no event bytes', async () => {
    const inaccessible = await request(app.getHttpServer()).get('/api/runs/run-sse/events')
      .set('Cookie', strangerCookie).set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(404);
    const absent = await request(app.getHttpServer()).get('/api/runs/run-absent/events')
      .set('Cookie', strangerCookie).set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(404);

    expect(inaccessible.body).toEqual(absent.body);
    expect(inaccessible.headers['content-type']).toContain('application/json');
  });

  it('sends comment heartbeats while idle and closes the response after client abort', async () => {
    const stream = await openStream(baseUrl, '/api/runs/run-sse/events', mayaCookie);
    await expect(stream.waitFor(/: heartbeat\n\n/)).resolves.toContain(': heartbeat\n\n');
    const closed = Promise.withResolvers<void>();
    stream.response.once('close', () => closed.resolve());
    stream.response.once('aborted', () => closed.resolve());
    stream.request.destroy();
    await closed.promise;
    expect(stream.response.destroyed).toBe(true);
  });
  it('returns 204 for a terminal watermark so native EventSource does not reconnect forever', async () => {
    await publisher.publish(event('evt-terminal', 'run-sse', 'complete', {}));
    await database.sql`update runs set status = 'completed', version = 1 where id = 'run-sse'`;

    await request(app.getHttpServer()).get('/api/runs/run-sse/events?after=evt-terminal')
      .set('Cookie', mayaCookie).set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(204);
    await expect(publisher.publish(event('evt-bad\nevent: complete', 'run-sse', 'progress', { status: 'running' }))).rejects.toThrow();
  });

  it('reauthorizes before each new event and closes without disclosing post-revocation data', async () => {
    await publisher.publish(event('evt-1', 'run-sse', 'progress', { status: 'retrieving' }));
    const stream = await openStream(baseUrl, '/api/runs/run-sse/events?after=evt-1', mayaCookie);
    await database.sql`delete from permission_grants where id = 'grant-sse'`;
    await publisher.publish(event('evt-after-revocation', 'run-sse', 'complete', {}));

    const body = await stream.ended;
    expect(body).not.toContain('evt-after-revocation');
  });

  it('bounds concurrent streams for one actor and run', async () => {
    const first = await openStream(baseUrl, '/api/runs/run-sse/events', mayaCookie);
    const second = await openStream(baseUrl, '/api/runs/run-sse/events', mayaCookie);
    await request(app.getHttpServer()).get('/api/runs/run-sse/events')
      .set('Cookie', mayaCookie).set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(429);
    const firstClosed = Promise.withResolvers<void>();
    const secondClosed = Promise.withResolvers<void>();
    first.response.once('close', () => firstClosed.resolve());
    second.response.once('close', () => secondClosed.resolve());
    first.request.destroy();
    second.request.destroy();
    await Promise.all([firstClosed.promise, secondClosed.promise]);
  });


  it('wakes subscribers across a worker connection and two API replicas without gaps', async () => {
    await publisher.publish(event('evt-1', 'run-sse', 'progress', { status: 'retrieving' }));
    const second = await createReplica();
    const secondUrl = new URL(await second.getUrl());
    const secondCookie = await login(second, maya.userId);
    const firstStream = await openStream(baseUrl, '/api/runs/run-sse/events?after=evt-1', mayaCookie);
    const secondStream = await openStream(secondUrl, '/api/runs/run-sse/events?after=evt-1', secondCookie);

    await publisher.publish(event('evt-2', 'run-sse', 'progress', { status: 'validating' }));
    await publisher.publish(event('evt-3', 'run-sse', 'complete', { status: 'completed', terminal: true }));
    const [firstBody, secondBody] = await Promise.all([firstStream.ended, secondStream.ended]);

    for (const body of [firstBody, secondBody]) {
      expect(body.match(/id: evt-2/g)).toHaveLength(1);
      expect(body.match(/id: evt-3/g)).toHaveLength(1);
      expect(body.indexOf('id: evt-2')).toBeLessThan(body.indexOf('id: evt-3'));
    }
  });

  it('emits transactionally linked Task 9 workflow events and a complete safe trace', async () => {
    const runId = 'run-trace';
    const store = new PostgresWorkflowStore(database);
    await database.sql`insert into accounts (id, name) values ('ACC-TRACE', 'Trace Account')`;
    await database.sql`insert into opportunities (id, account_id, name) values ('OPP-TRACE', 'ACC-TRACE', 'Trace Opportunity')`;
    await database.sql`insert into permission_grants (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing)
      values ('grant-trace', ${maya.userId}, 'ACC-TRACE', 'salesforce', true, false, true, false, false)`;
    const command = (step: string, ordinal: number, payload: Readonly<Record<string, unknown>> = {}): WorkflowCommand => ({
      id: `command-trace-${ordinal}`,
      runId: runId as never,
      type: 'process-deal-brief-step',
      payload: { step, ...payload },
      idempotencyKey: `run-trace:${step}:${ordinal}`
    });
    const startCommand = command('start', 0);
    await store.startRun({
      id: runId as never,
      opportunityId: 'OPP-TRACE' as never,
      requestedBy: maya.userId as never,
      status: 'created',
      generationProvider: 'mock',
      generationModel: 'mock-brief',
      idempotencyKey: 'run-trace-start',
      startRequestHash: 'c'.repeat(64),
      command: startCommand,
      budget: { scope: runId as never, maxCalls: 10, maxInputTokens: 1_000, maxOutputTokens: 500, deadlineMs: 30_000 }
    });
    const watermark = (await database.sql<{ id: string }[]>`select id from run_events where run_id = ${runId} order by sequence desc limit 1`)[0]!.id;
    const observed = (async (): Promise<RunEventEnvelope[]> => {
      const values: RunEventEnvelope[] = [];
      for await (const next of publisher.subscribe(runId, watermark)) {
        values.push(next);
        if (next.type === 'complete') break;
      }
      return values;
    })();
    const claim = async (workflowCommand: WorkflowCommand, step: string, ordinal: number): Promise<StepLease> => {
      await database.sql`update outbox_commands set status = 'published', published_at = now() where id = ${workflowCommand.id}`;
      const lease = await store.claimStep({
        runId: runId as never,
        step,
        invocationId: `invocation-trace-${ordinal}`,
        causalCommandId: workflowCommand.id,
        owner: 'trace-worker',
        leaseMs: 30_000
      });
      if (lease === undefined) throw new Error(`Unable to claim trace step ${step}`);
      return lease;
    };
    const commit = async (
      lease: StepLease,
      currentVersion: number,
      causal: WorkflowCommand,
      eventType: RunEvent,
      checkpointStep: string,
      checkpoint: Readonly<Record<string, unknown>>,
      nextCommand: WorkflowCommand
    ): Promise<number> => (await store.commitStepAndEnqueueNext({
      runId: runId as never,
      expectedVersion: currentVersion,
      invocationId: lease.invocationId,
      invocationOwner: lease.owner,
      leaseToken: lease.leaseToken,
      causalCommandId: causal.id,
      event: eventType,
      checkpointStep,
      checkpoint,
      nextCommand
    })).version;
    const seedGenerationAttempt = async (logicalGenerationId: string, operation: string, ordinal = 1, validationAttempts = 0): Promise<void> => {
      await database.sql`insert into generation_attempts
        (id, run_id, logical_generation_id, operation, ordinal, status, provider, model, output_mode,
          validation_attempts, possible_duplicate, input_tokens, output_tokens, completed_at)
        values (${`attempt-${logicalGenerationId}-${ordinal}`}, ${runId}, ${logicalGenerationId}, ${operation}, ${ordinal},
          'completed', 'mock', 'mock-brief', 'native_schema', ${validationAttempts}, false, ${10 * ordinal}, ${4 * ordinal}, now())`;
    };

    const retrieveCommand = command('retrieve', 1);
    let version = await commit(await claim(startCommand, 'start', 0), 0, startCommand, 'start', 'start', {}, retrieveCommand);
    const specialistsCommand = command('specialists', 2);
    version = await commit(
      await claim(retrieveCommand, 'retrieve', 1),
      version,
      retrieveCommand,
      'retrieval_completed',
      'retrieval',
      { status: 'completed', value: { evidence: [], diagnostics: { returned: 0 } } },
      specialistsCommand
    );
    const specialistLease = await claim(specialistsCommand, 'specialists', 2);
    for (const specialist of ['conversation', 'stakeholder', 'commercial']) {
      await seedGenerationAttempt(`generation-${specialist}`, specialist);
      await store.saveCheckpoint({
        runId: runId as never,
        step: `specialist:${specialist}`,
        invocationId: specialistLease.invocationId,
        invocationOwner: specialistLease.owner,
        leaseToken: specialistLease.leaseToken,
        logicalGenerationId: `generation-${specialist}`,
        checkpoint: {
          status: specialist === 'conversation' ? 'degraded' : 'completed',
          value: { claims: [] },
          generation: { provider: 'mock', model: 'mock-brief', operation: specialist }
        }
      });
    }
    const synthesizeCommand = command('synthesize', 3);
    version = await commit(specialistLease, version, specialistsCommand, 'specialists_completed', 'specialists', { status: 'completed' }, synthesizeCommand);
    const brief = dealBriefSchema.parse({
      dealSnapshot: { accountName: 'Trace Account', opportunityName: 'Trace Opportunity', stage: 'Negotiate' },
      executiveSummary: { narrative: 'Insufficient supported evidence is available for an executive summary.' },
      buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
      stakeholderMap: { stakeholders: [] },
      negotiationState: { currentState: 'Insufficient supported evidence is available.', risks: [] },
      recommendedNextActions: { actions: [] },
      missingInformation: { items: [] },
      sourceEvidence: { evidence: [] },
      confidenceAndReviewWarnings: { overallConfidence: 0.5, warnings: [] }
    });
    const synthesizeLease = await claim(synthesizeCommand, 'synthesize', 3);
    await seedGenerationAttempt('generation-strategy', 'strategy', 1);
    await seedGenerationAttempt('generation-strategy', 'strategy', 2, 1);
    await store.saveCheckpoint({
      runId: runId as never,
      step: 'strategy:1',
      invocationId: synthesizeLease.invocationId,
      invocationOwner: synthesizeLease.owner,
      leaseToken: synthesizeLease.leaseToken,
      logicalGenerationId: 'generation-strategy',
      checkpoint: { status: 'completed', value: brief, generation: { provider: 'mock', model: 'mock-brief', operation: 'strategy' } }
    });
    const validateCommand = command('validate', 4, { draftVersion: 1 });
    version = await commit(synthesizeLease, version, synthesizeCommand, 'synthesis_completed', 'synthesis:1', { status: 'completed' }, validateCommand);
    const subjectHash = hashApprovalPayload(brief);
    const finalizeCommand = command('finalize', 5, { subjectHash, payload: brief });
    version = await commit(
      await claim(validateCommand, 'validate', 4),
      version,
      validateCommand,
      'validation_completed',
      'validation:1',
      { status: 'completed', subjectHash, payload: brief },
      finalizeCommand
    );
    const finalizeLease = await claim(finalizeCommand, 'finalize', 5);
    await store.finalizeRun({
      runId: runId as never,
      expectedVersion: version,
      invocationId: finalizeLease.invocationId,
      invocationOwner: finalizeLease.owner,
      leaseToken: finalizeLease.leaseToken,
      causalCommandId: finalizeCommand.id,
      subjectHash,
      payload: brief
    });

    const events = await observed;
    expect(events.at(-1)?.type).toBe('complete');
    expect(events.every(({ streamId }) => streamId === runId)).toBe(true);
    await expect(publisher.assertTraceComplete(runId)).resolves.toBeUndefined();
    const spans = await publisher.tracesForRun(runId);
    expect(spans.filter(({ kind }) => kind === 'authorization_lookup')).toEqual([
      expect.objectContaining({ status: 'completed', data: expect.objectContaining({ decision: 'allowed' }) })
    ]);
    expect(spans.find(({ kind }) => kind === 'authorization_lookup')?.data).not.toHaveProperty('resultIds');
    expect(spans.filter(({ kind }) => kind === 'specialist_attempt').map(({ step }) => step).sort()).toEqual(['commercial', 'conversation', 'stakeholder']);
    expect(spans.filter(({ kind, step }) => kind === 'model_call' && step === 'strategy')).toHaveLength(2);
    expect(spans).toContainEqual(expect.objectContaining({ kind: 'repair', step: 'strategy', attempt: 2 }));
    const degradedAttempt = spans.find(({ kind, step }) => kind === 'specialist_attempt' && step === 'conversation');
    expect(degradedAttempt?.status).toBe('degraded');
    expect(spans).toContainEqual(expect.objectContaining({
      kind: 'partial_failure', parentSpanId: degradedAttempt?.spanId, status: 'degraded'
    }));
  });

  it('persists a complete awaiting-approval trace through the production workflow store', async () => {
    const runId = 'run-awaiting';
    const store = new PostgresWorkflowStore(database);
    await database.sql`insert into accounts (id, name) values ('ACC-AWAIT', 'Await Account')`;
    await database.sql`insert into opportunities (id, account_id, name) values ('OPP-AWAIT', 'ACC-AWAIT', 'Await Opportunity')`;
    const startCommand: WorkflowCommand = {
      id: 'command-await-start', runId: runId as never, type: 'process-deal-brief-step',
      payload: { step: 'start' }, idempotencyKey: 'run-await:start'
    };
    await store.startRun({
      id: runId as never, opportunityId: 'OPP-AWAIT' as never, requestedBy: maya.userId as never, status: 'created',
      generationProvider: 'mock', generationModel: 'mock-brief', idempotencyKey: 'run-await',
      startRequestHash: 'a'.repeat(64), command: startCommand,
      budget: { scope: runId as never, maxCalls: 10, maxInputTokens: 1_000, maxOutputTokens: 500, deadlineMs: 30_000 }
    });
    const auth = (await publisher.tracesForRun(runId))[0]!;
    const append = async (
      kind: Parameters<PostgresEventStore['appendTrace']>[0]['kind'],
      step: string,
      suffix: string,
      parentSpanId: string,
      data: Readonly<Record<string, unknown>>
    ): Promise<string> => {
      const spanId = `span-await-${suffix}`;
      await publisher.appendTrace({
        traceId: auth.traceId, spanId, runId, parentSpanId, step, attempt: 1, kind,
        status: 'completed', startedAt: timestamp, endedAt: timestamp, data
      } as never);
      return spanId;
    };
    const retrieval = await append('evidence_retrieval', 'retrieval', 'retrieval', auth.spanId, { resultIds: [], scores: [], evidenceCount: 0 });
    for (const specialist of ['conversation', 'stakeholder', 'commercial']) {
      const attempt = await append('specialist_attempt', specialist, `${specialist}-attempt`, retrieval, { operation: specialist, logicalGenerationId: `generation-await-${specialist}` });
      const model = await append('model_call', specialist, `${specialist}-model`, attempt, {
        durableAttemptId: `attempt-await-${specialist}`, logicalGenerationId: `generation-await-${specialist}`, ordinal: 1,
        provider: 'mock', model: 'mock-brief', parametersHash: 'b'.repeat(64), outputMode: 'native_schema', possibleDuplicate: false
      });
      await append('validation', specialist, `${specialist}-validation`, model, { decision: 'accepted', validationAttempts: 0 });
      await append('guardrail', specialist, `${specialist}-guardrail`, model, { decision: 'passed' });
      await append('usage', specialist, `${specialist}-usage`, model, { inputTokens: 10, outputTokens: 4 });
    }
    const strategy = await append('strategy_attempt', 'strategy', 'strategy-attempt', retrieval, { operation: 'strategy', logicalGenerationId: 'generation-await-strategy' });
    const strategyModel = await append('model_call', 'strategy', 'strategy-model', strategy, {
      durableAttemptId: 'attempt-await-strategy', logicalGenerationId: 'generation-await-strategy', ordinal: 1,
      provider: 'mock', model: 'mock-brief', parametersHash: 'c'.repeat(64), outputMode: 'native_schema', possibleDuplicate: false
    });
    await append('validation', 'strategy', 'strategy-validation', strategyModel, { decision: 'accepted', validationAttempts: 0 });
    await append('guardrail', 'strategy', 'strategy-guardrail', strategyModel, { decision: 'passed' });
    await append('usage', 'strategy', 'strategy-usage', strategyModel, { inputTokens: 20, outputTokens: 8 });
    await database.sql`update runs set status = 'validating', version = 4 where id = ${runId}`;
    await database.sql`update outbox_commands set status = 'published', published_at = now() where id = ${startCommand.id}`;
    const lease = await store.claimStep({
      runId: runId as never, step: 'validate', invocationId: 'invocation-await', causalCommandId: startCommand.id,
      owner: 'await-worker', leaseMs: 30_000
    });
    if (lease === undefined) throw new Error('Unable to claim awaiting validation');
    const brief = dealBriefSchema.parse({
      dealSnapshot: { accountName: 'Await Account', opportunityName: 'Await Opportunity', stage: 'Negotiate' },
      executiveSummary: { narrative: 'Insufficient supported evidence is available for an executive summary.' },
      buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
      stakeholderMap: { stakeholders: [] },
      negotiationState: { currentState: 'Insufficient supported evidence is available.', risks: [] },
      recommendedNextActions: { actions: [] },
      missingInformation: { items: [] },
      sourceEvidence: { evidence: [] },
      confidenceAndReviewWarnings: { overallConfidence: 0.5, warnings: [] }
    });
    const subjectHash = hashApprovalPayload(brief);
    await store.awaitApproval({
      runId: runId as never, expectedVersion: 4, invocationId: lease.invocationId, invocationOwner: lease.owner,
      leaseToken: lease.leaseToken, causalCommandId: startCommand.id,
      subject: {
        id: 'subject-await' as never, runId: runId as never, draftVersion: 4, subjectHash, payload: brief,
        sectionIds: [], recommendationIds: [], citationIds: [], policyTriggers: ['discount'],
        entries: [{
          id: 'entry-await', category: 'commercial_discount', eligibleAuthorities: ['deal_desk'],
          policyTriggers: ['discount'], dependsOn: []
        }], quorumVersion: 'policy-v1', decisions: []
      }
    });
    await expect(publisher.assertTraceComplete(runId)).resolves.toBeUndefined();
    expect((await publisher.tracesForRun(runId))).toContainEqual(expect.objectContaining({ kind: 'approval_requirement' }));
  });

  it('persists a failed production trace linked to its exact triggering attempt', async () => {
    const runId = 'run-failed-production';
    const store = new PostgresWorkflowStore(database);
    await database.sql`insert into accounts (id, name) values ('ACC-FAIL', 'Fail Account')`;
    await database.sql`insert into opportunities (id, account_id, name) values ('OPP-FAIL', 'ACC-FAIL', 'Fail Opportunity')`;
    const command: WorkflowCommand = {
      id: 'command-fail-start', runId: runId as never, type: 'process-deal-brief-step',
      payload: { step: 'start' }, idempotencyKey: 'run-fail:start'
    };
    await store.startRun({
      id: runId as never, opportunityId: 'OPP-FAIL' as never, requestedBy: maya.userId as never, status: 'created',
      generationProvider: 'mock', generationModel: 'mock-brief', idempotencyKey: 'run-fail',
      startRequestHash: 'd'.repeat(64), command,
      budget: { scope: runId as never, maxCalls: 10, maxInputTokens: 1_000, maxOutputTokens: 500, deadlineMs: 30_000 }
    });
    await database.sql`update runs set status = 'synthesizing', version = 3 where id = ${runId}`;
    await database.sql`update outbox_commands set status = 'published', published_at = now() where id = ${command.id}`;
    const lease = await store.claimStep({
      runId: runId as never, step: 'synthesize', invocationId: 'invocation-fail', causalCommandId: command.id,
      owner: 'fail-worker', leaseMs: 30_000
    });
    if (lease === undefined) throw new Error('Unable to claim failing synthesis');
    await store.failRun({
      runId: runId as never, expectedVersion: 3, invocationId: lease.invocationId, invocationOwner: lease.owner,
      leaseToken: lease.leaseToken, causalCommandId: command.id, reason: 'strategy_generation_failed'
    });
    await expect(publisher.assertTraceComplete(runId)).resolves.toBeUndefined();
    const spans = await publisher.tracesForRun(runId);
    const attempt = spans.find(({ kind }) => kind === 'strategy_attempt');
    expect(spans).toContainEqual(expect.objectContaining({
      kind: 'fatal_failure', parentSpanId: attempt?.spanId, status: 'failed'
    }));
  });
  it('keeps denied attempts separate when the same start later becomes authorized', async () => {
    await database.sql`insert into accounts (id, name) values ('ACC-DENIAL', 'Denied Account')`;
    await database.sql`insert into opportunities (id, account_id, name) values ('OPP-DENIAL', 'ACC-DENIAL', 'Denied Opportunity')`;
    const start = new StartDealBrief(
      new PostgresWorkflowStore(database),

      new PostgresDealBriefAccessControl(database),
      { provider: 'mock', model: 'mock-brief' }
    );

    await expect(start.execute({
      opportunityId: 'OPP-DENIAL',
      requestedBy: stranger.userId,
      idempotencyKey: 'denied-trace',
      budget: { maxCalls: 10, maxInputTokens: 1_000, maxOutputTokens: 500, deadlineMs: 30_000 }
    })).rejects.toThrow('DealBrief start denied');
    const [{ run_id: deniedTraceId }] = await database.sql<{ run_id: string }[]>`
      select run_id from trace_spans where kind = 'authorization_lookup' and status = 'denied'
      order by started_at desc limit 1`;

    await expect(publisher.assertTraceComplete(deniedTraceId)).resolves.toBeUndefined();
    const deniedSpans = await publisher.tracesForRun(deniedTraceId);
    expect(deniedSpans).toEqual([
      expect.objectContaining({
        kind: 'authorization_lookup',
        status: 'denied',
        data: {
          decision: 'denied',
          correlationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          reasonCode: 'forbidden',
          readKinds: ['opportunity', 'account', 'requester', 'permissions'],
          readCount: 4
        }
      })
    ]);
    const [{ event_count: eventCount, run_count: runCount }] = await database.sql<{ event_count: number; run_count: number }[]>`
      select (select count(*)::int from run_events where run_id = ${deniedTraceId}) event_count,
        (select count(*)::int from runs where id = ${deniedTraceId}) run_count`;
    expect({ eventCount, runCount }).toEqual({ eventCount: 0, runCount: 0 });

    await database.sql`insert into permission_grants
      (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing)
      values ('grant-denial-retry', ${stranger.userId}, 'ACC-DENIAL', 'salesforce', true, false, true, false, false)`;
    const allowedRunId = await start.execute({
      opportunityId: 'OPP-DENIAL',
      requestedBy: stranger.userId,
      idempotencyKey: 'denied-trace',
      budget: { maxCalls: 10, maxInputTokens: 1_000, maxOutputTokens: 500, deadlineMs: 30_000 }
    });
    expect(allowedRunId).not.toBe(deniedTraceId);
    const allowedSpans = await publisher.tracesForRun(allowedRunId);
    expect(allowedSpans).toEqual([
      expect.objectContaining({ kind: 'authorization_lookup', status: 'completed', data: expect.objectContaining({ decision: 'allowed' }) })
    ]);
  });
});
