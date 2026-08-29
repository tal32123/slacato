import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DecideApproval, DomainValidationError, ProcessDealBriefStep, RegenerateDealBrief, StartDealBrief,
  dealBriefSchema, type DealBriefWorkflowServices
} from '@slacato/core';
import {
  BullMqCommandQueue, OutboxDispatcher, OutboxDispatcherLoop, PostgresDealBriefAccessControl, PostgresWorkflowStore,
  WORKFLOW_QUEUE_NAME, createDatabaseClient
} from '@slacato/infrastructure';
import { AppModule } from '../../apps/api/src/app.module';
import { configureApiApplication } from '../../apps/api/src/main';
import { DealBriefProcessor } from '../../apps/worker/src/processors/deal-brief.processor';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';
const suffix = crypto.randomUUID().replaceAll('-', '');
const numeric = BigInt(`0x${suffix.slice(0, 15)}`).toString();
const requester = `USR-${numeric}1`;
const approver = `USR-${numeric}2`;
const account = `ACC-${numeric}`;
const opportunity = `OPP-${numeric}`;
const origin = 'http://127.0.0.1:4173';
const database = createDatabaseClient(databaseUrl, 4);
const admin = postgres(databaseUrl, { max: 1 });
let app: NestExpressApplication | undefined;
let processor: DealBriefProcessor | undefined;
let loop: OutboxDispatcherLoop | undefined;
let queue: BullMqCommandQueue | undefined;

async function waitFor<T>(read: () => Promise<T | undefined>, attempts = 20_000): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read(); if (value !== undefined) return value;
    const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise;
  }
  throw new Error('Durable workflow state was not observed');
}

afterAll(async () => {
  if (loop !== undefined) await loop.stop();
  if (processor !== undefined) await processor.close();
  if (app !== undefined) await app.close();
  if (queue !== undefined) { await queue.queue.drain(true); await queue.close(); }
  // Unique IDs isolate durable rows; PostgreSQL foreign keys intentionally retain the audit graph.
  await admin.end({ timeout: 5 }); await database.close();
});

describe('production DealBrief seams', () => {
  it('crosses authenticated API, PostgreSQL outbox, BullMQ processor, approval wait, quorum, and deterministic finalization', async () => {
    const catalog = await admin<{ present: boolean }[]>`select to_regclass('approval_authority_grants') is not null present`;
    if (catalog[0]?.present !== true) {
      const migration = await readFile(resolve(process.cwd(), 'drizzle/0014_durable_brief_approvals.sql'), 'utf8');
      await admin.unsafe(migration);
    }
    await admin`insert into personas (id, display_name, role) values (${requester}, 'Workflow Requester', 'Account Owner'), (${approver}, 'Workflow Approver', 'Deal Desk Approver')`;
    await admin`insert into accounts (id, name) values (${account}, 'Workflow Account')`;
    await admin`insert into opportunities (id, account_id, name, restricted) values (${opportunity}, ${account}, 'Workflow Opportunity', false)`;
    await admin`insert into permission_grants (id, persona_id, account_id, source_type, can_read, can_request_approval)
      values (${`grant_${suffix}`}, ${requester}, ${account}, 'salesforce', true, true)`;
    await admin`insert into approval_authority_grants (id, persona_id, account_id, authority, source) values
      (${`authority_${suffix}`}, ${approver}, ${account}, 'deal_desk', 'task-9-production-test')`;
    await admin`insert into opportunity_policy_facts (opportunity_id, discount_percent, renewal_uplift_percent, source_commit)
      values (${opportunity}, 12, 1, 'task-9-production-test')`;

    const store = new PostgresWorkflowStore(database); const access = new PostgresDealBriefAccessControl(database);
    const strategyCalls = new Map<string, number>();
    const services: DealBriefWorkflowServices = {
      async retrieve() { return { manifestId: `manifest_${suffix}` }; },
      async conversation() { return { goals: [] }; }, async stakeholder() { return { stakeholders: [] }; }, async commercial() { return { terms: [] }; },
      async strategy(run) { strategyCalls.set(run.id, (strategyCalls.get(run.id) ?? 0) + 1); return dealBriefSchema.parse({
        dealSnapshot: { accountName: 'Workflow Account', opportunityName: 'Workflow Opportunity', stage: 'Negotiate' },
        executiveSummary: { narrative: 'Insufficient verified information is available.' }, buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
        stakeholderMap: { stakeholders: [] }, negotiationState: { currentState: 'Insufficient supported evidence is available.', risks: [] },
        recommendedNextActions: { actions: [] }, missingInformation: { items: [] }, sourceEvidence: { evidence: [] },
        confidenceAndReviewWarnings: { overallConfidence: 0.9, warnings: [] }
      }); },
      approvalInput() { return { discountPercent: 12, renewalUpliftPercent: 1, liabilityCapChanged: false, dataRetentionLanguage: false,
        restrictedResearchLanguage: false, customerSpecificSecurityLanguage: false, customerFacingConcessionLanguage: false,
        overallConfidence: 0.9, conflictingEvidence: false, missingMaterialEvidence: false }; },
      validateDraft(value) { return dealBriefSchema.parse(value); }
    };
    queue = new BullMqCommandQueue(redisUrl, WORKFLOW_QUEUE_NAME); await queue.queue.drain(true);
    processor = new DealBriefProcessor(new ProcessDealBriefStep(store, services, { leaseMs: 30_000 }), { redisUrl, workerId: `test-${suffix}`, concurrency: 1, jobsPerSecond: 20 });
    loop = new OutboxDispatcherLoop(new OutboxDispatcher(database, queue, queue), 10, 20); loop.start();
    const directory = {
      async list() { return [requester, approver].map((userId) => ({ userId, displayName: userId === requester ? 'Workflow Requester' : 'Workflow Approver', role: userId === requester ? 'Account Owner' : 'Deal Desk Approver', grants: [] })); },
      async findById(userId: string) { return (await this.list()).find((persona) => persona.userId === userId); }
    };
    app = await NestFactory.create<NestExpressApplication>(AppModule.register({ sessionSecret: 'task-9-production-test-secret-which-is-long', environment: 'test', allowedOrigins: [origin], personaDirectory: directory }, {
      startDealBrief: new StartDealBrief(store, access, { provider: 'mock', model: 'mock-brief' }),
      regenerateDealBrief: new RegenerateDealBrief(store, access),
      decideApproval: new DecideApproval(store, access)
    }), { bodyParser: false, logger: false });
    configureApiApplication(app); await app.init();
    const browser = request.agent(app.getHttpServer());
    const bootstrap = await browser.get('/api/auth/csrf').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(200);
    const selected = await browser.post('/api/auth/persona').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').set('X-CSRF-Token', bootstrap.body.csrfToken).send({ userId: requester }).expect(201);
    const started = await browser.post('/api/runs/deal-brief').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').set('X-CSRF-Token', selected.body.csrfToken)
      .send({ opportunityId: opportunity, idempotencyKey: `start-${suffix}`, budget: { maxCalls: 12, maxInputTokens: 10000, maxOutputTokens: 2000, deadlineMs: 30000 } }).expect(201);
    const runId = started.body.runId as string;
    const waiting = await waitFor(async () => {
      const current = await store.getRun(runId as never);
      if (current?.status === 'failed') throw new Error(`Workflow failed: ${current.errorCode}: ${current.errorMessage}`);
      return current?.status === 'awaiting_approval' ? current : undefined;
    });
    expect(waiting.status).toBe('awaiting_approval'); expect(strategyCalls.get(runId)).toBe(1); expect(await queue.queue.getJob(runId)).toBeUndefined();
    const subject = await store.getApprovalSubject({ runId: runId as never }); const entry = subject?.entries[0];
    if (subject === undefined || entry === undefined) throw new Error('Approval subject not persisted');
    await admin`insert into run_evidence_manifests (id, run_id, scope_hash, policy_hash, query_hash, index_profile,
      embedding_provider, embedding_model, embedding_dimension, embedding_version, embedding_normalization, context_limit, diagnostics)
      values (${`manifest_${suffix}`}, ${runId}, ${'a'.repeat(64)}, ${'b'.repeat(64)}, ${'c'.repeat(64)}, 'task-9',
      'mock', 'mock-embedding', 3, 'v1', 'l2', 1000, '{}'::jsonb)`;
    const unsupportedEdit = dealBriefSchema.parse({
      ...subject.payload, executiveSummary: { narrative: 'we can offer a reduction' }
    });
    await expect(access.validateApprovalEdit({
      actorId: requester, opportunityId: opportunity, runId, payload: unsupportedEdit
    })).rejects.toBeInstanceOf(DomainValidationError);
    const regenerationResponse = await browser.post(`/api/runs/${runId}/regenerate`).set('Origin', origin).set('Sec-Fetch-Site', 'same-site')
      .set('X-CSRF-Token', selected.body.csrfToken).send({ idempotencyKey: `regenerate-${suffix}` });
    expect(regenerationResponse.status, JSON.stringify(regenerationResponse.body)).toBe(201);
    const regenerated = await waitFor(async () => {
      const current = await store.getRun(runId as never);
      return current?.status === 'awaiting_approval' && current.version > waiting.version ? current : undefined;
    });
    const regeneratedSubject = await store.getApprovalSubject({ runId: runId as never });
    const regeneratedEntry = regeneratedSubject?.entries[0];
    if (regeneratedSubject === undefined || regeneratedEntry === undefined) throw new Error('Regenerated approval subject not persisted');
    expect(regeneratedSubject.id).not.toBe(subject.id);
    expect(strategyCalls.get(runId)).toBe(2);
    expect(await queue.queue.getJob(runId)).toBeUndefined();
    const switched = await browser.post('/api/auth/persona').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').set('X-CSRF-Token', selected.body.csrfToken).send({ userId: approver }).expect(201);
    await browser.post('/api/approvals/decisions').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').set('X-CSRF-Token', switched.body.csrfToken).send({
      runId, approvalSubjectId: regeneratedSubject.id, expectedRunVersion: regenerated.version, expectedSubjectHash: regeneratedSubject.subjectHash,
      entryId: regeneratedEntry.id, category: regeneratedEntry.category, authority: 'deal_desk', action: 'approve_unchanged', idempotencyKey: `approve-${suffix}`
    }).expect(201);
    const completed = await waitFor(async () => (await store.getRun(runId as never))?.status === 'completed' ? store.getRun(runId as never) : undefined);
    expect(completed.status).toBe('completed'); expect(strategyCalls.get(runId)).toBe(2);
  }, 20_000);
});
