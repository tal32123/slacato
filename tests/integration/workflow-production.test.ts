import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CANONICAL_FIXTURE_COMMIT, DecideApproval, DomainConflictError, DomainValidationError, ProcessDealBriefStep,
  RegenerateDealBrief, StartDealBrief, dealBriefSchema, hashApprovalPayload, type DealBriefWorkflowServices
} from '@slacato/core';
import {
  BullMqCommandQueue, OutboxDispatcher, OutboxDispatcherLoop, PostgresDealBriefAccessControl, PostgresWorkflowStore,
  WORKFLOW_QUEUE_NAME, createDatabaseClient
} from '@slacato/infrastructure';
import { AppModule } from '../../apps/api/src/app.module';
import { configureApiApplication } from '../../apps/api/src/main';
import { DealBriefProcessor, PostgresDealBriefWorkflowServices } from '../../apps/worker/src/processors/deal-brief.processor';

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

function approvalBrief(label: string) {
  return dealBriefSchema.parse({
    dealSnapshot: { accountName: label, opportunityName: `${label} Opportunity`, stage: 'Negotiate' },
    executiveSummary: { narrative: 'Insufficient supported evidence is available for an executive summary.' },
    buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] }, stakeholderMap: { stakeholders: [] },
    negotiationState: { currentState: 'Insufficient supported evidence is available.', risks: [] },
    recommendedNextActions: { actions: [] }, missingInformation: { items: [] }, sourceEvidence: { evidence: [] },
    confidenceAndReviewWarnings: { overallConfidence: 0.9, warnings: [] }
  });
}

async function waitFor<T>(read: () => Promise<T | undefined>, attempts = 20_000): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read(); if (value !== undefined) return value;
    const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise;
  }
  throw new Error('Durable workflow state was not observed');
}

beforeAll(async () => {
  const approvalCatalog = await admin<{ present: boolean }[]>`select to_regclass('approval_authority_grants') is not null present`;
  if (approvalCatalog[0]?.present !== true) {
    const migration = await readFile(resolve(process.cwd(), 'drizzle/0014_durable_brief_approvals.sql'), 'utf8');
    await admin.unsafe(migration);
  }
  const replayCatalog = await admin<{ present: boolean }[]>`select exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'approval_decisions' and column_name = 'result_status'
  ) present`;
  if (replayCatalog[0]?.present !== true) {
    const migration = await readFile(resolve(process.cwd(), 'drizzle/0015_immutable_approval_replays.sql'), 'utf8');
    await admin.unsafe(migration);
  }
  const observabilityCatalog = await admin<{ present: boolean }[]>`select exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'trace_spans' and column_name = 'span_id'
  ) present`;
  if (observabilityCatalog[0]?.present !== true) {
    const migration = await readFile(resolve(process.cwd(), 'drizzle/0016_append_only_run_observability.sql'), 'utf8');
    await admin.unsafe(migration);
  }
});

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
    await admin`insert into personas (id, display_name, role, source_commit) values
      (${requester}, 'Workflow Requester', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT}),
      (${approver}, 'Workflow Approver', 'Deal Desk Approver', ${CANONICAL_FIXTURE_COMMIT})`;
    await admin`insert into accounts (id, name) values (${account}, 'Workflow Account')`;
    await admin`insert into opportunities (id, account_id, name, restricted) values (${opportunity}, ${account}, 'Workflow Opportunity', false)`;
    await admin`insert into permission_grants (id, persona_id, account_id, source_type, can_read, can_request_approval, source_commit)
      values (${`grant_${suffix}`}, ${requester}, ${account}, 'salesforce', true, true, ${CANONICAL_FIXTURE_COMMIT})`;
    await admin`insert into approval_authority_grants (id, persona_id, account_id, authority, source, source_commit) values
      (${`authority_${suffix}`}, ${approver}, ${account}, 'deal_desk', 'task-9-production-test', ${CANONICAL_FIXTURE_COMMIT})`;
    await admin`insert into opportunity_policy_facts (opportunity_id, discount_percent, renewal_uplift_percent, source_commit)
      values (${opportunity}, 12, 1, 'task-9-production-test')`;

    const store = new PostgresWorkflowStore(database); const access = new PostgresDealBriefAccessControl(database);
    const strategyCalls = new Map<string, number>();
    const retrievalCalls = new Map<string, number>();
    const services: DealBriefWorkflowServices = {
      async retrieve(run) {
        const attempt = (retrievalCalls.get(run.id) ?? 0) + 1; retrievalCalls.set(run.id, attempt);
        if (attempt === 1) throw new Error('transient retrieval failure');
        return { manifestId: `manifest_${suffix}` };
      },
      async conversation() { return { goals: [] }; }, async stakeholder() { return { stakeholders: [] }; }, async commercial() { return { terms: [] }; },
      async strategy(run) { strategyCalls.set(run.id, (strategyCalls.get(run.id) ?? 0) + 1); return dealBriefSchema.parse({
        dealSnapshot: { accountName: 'Workflow Account', opportunityName: 'Workflow Opportunity', stage: 'Negotiate' },
        executiveSummary: { narrative: 'Insufficient supported evidence is available for an executive summary.' }, buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
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
    expect(waiting.status).toBe('awaiting_approval'); expect(retrievalCalls.get(runId)).toBe(2); expect(strategyCalls.get(runId)).toBe(1); expect(await queue.queue.getJob(runId)).toBeUndefined();
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
    const regenerationReplay = await browser.post(`/api/runs/${runId}/regenerate`).set('Origin', origin).set('Sec-Fetch-Site', 'same-site')
      .set('X-CSRF-Token', selected.body.csrfToken).send({ idempotencyKey: `regenerate-${suffix}` }).expect(201);
    expect(regenerationReplay.body.runId).toBe(runId);
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
    const editCommand = {
      runId, approvalSubjectId: regeneratedSubject.id, expectedRunVersion: regenerated.version,
      expectedSubjectHash: regeneratedSubject.subjectHash, entryId: regeneratedEntry.id, category: regeneratedEntry.category,
      authority: 'deal_desk', action: 'edit_and_approve', rationale: 'Confirm the exact grounded snapshot.',
      editedPayload: regeneratedSubject.payload, idempotencyKey: `edit-${suffix}`
    };
    const editResult = await browser.post('/api/approvals/decisions').set('Origin', origin).set('Sec-Fetch-Site', 'same-site')
      .set('X-CSRF-Token', switched.body.csrfToken).send(editCommand);
    expect(editResult.status, JSON.stringify(editResult.body)).toBe(201);
    const editReplay = await browser.post('/api/approvals/decisions').set('Origin', origin).set('Sec-Fetch-Site', 'same-site')
      .set('X-CSRF-Token', switched.body.csrfToken).send(editCommand).expect(201);
    expect(editReplay.body).toEqual({ ...editResult.body, replayed: true });
    const replacement = await store.getApprovalSubject({ runId: runId as never }); const replacementEntry = replacement?.entries[0];
    const editedRun = await store.getRun(runId as never);
    if (replacement === undefined || replacementEntry === undefined || editedRun === undefined) throw new Error('Edited replacement subject not persisted');
    await browser.post('/api/approvals/decisions').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').set('X-CSRF-Token', switched.body.csrfToken).send({
      runId, approvalSubjectId: replacement.id, expectedRunVersion: editedRun.version, expectedSubjectHash: replacement.subjectHash,
      entryId: replacementEntry.id, category: replacementEntry.category, authority: 'deal_desk', action: 'approve_unchanged', idempotencyKey: `approve-${suffix}`
    }).expect(201);
    const completed = await waitFor(async () => (await store.getRun(runId as never))?.status === 'completed' ? store.getRun(runId as never) : undefined);
    expect(completed.status).toBe('completed'); expect(strategyCalls.get(runId)).toBe(2);
  }, 20_000);
  it('reauthorizes canonical permission provenance before worker retrieval', async () => {
    const row = (await admin<{ id: string }[]>`select id from runs where opportunity_id = ${opportunity} order by created_at desc limit 1`)[0];
    if (row === undefined) throw new Error('Workflow run fixture is unavailable');
    const store = new PostgresWorkflowStore(database);
    const run = await store.getRun(row.id as never);
    if (run === undefined) throw new Error('Workflow run fixture could not be loaded');
    await admin`update permission_grants set source_commit = ${'a'.repeat(40)} where id = ${`grant_${suffix}`}`;
    try {
      const services = new PostgresDealBriefWorkflowServices(database, {
        provider: 'mock',
        registry: { resolve: () => ({ modelId: 'mock-brief' }) }
      } as never);
      await expect(services.retrieve(run, `invocation-stale-${suffix}`))
        .rejects.toThrow('Authorized opportunity context is unavailable');
    } finally {
      await admin`update permission_grants set source_commit = ${CANONICAL_FIXTURE_COMMIT} where id = ${`grant_${suffix}`}`;
    }
  });


  it('replays the original non-quorate unchanged approval after a later edit supersedes its subject', async () => {
    const replaySuffix = crypto.randomUUID().replaceAll('-', '');
    const replayNumeric = BigInt(`0x${replaySuffix.slice(0, 15)}`).toString();
    const replayRequester = `USR-${replayNumeric}1`;
    const firstApprover = `USR-${replayNumeric}2`;
    const secondApprover = `USR-${replayNumeric}3`;
    const replayAccount = `ACC-${replayNumeric}`;
    const replayOpportunity = `OPP-${replayNumeric}`;
    const runId = `run_${replaySuffix}`;
    const subjectId = `approval_subject_${replaySuffix}`;
    const replacementId = `approval_subject_replacement_${replaySuffix}`;
    const firstEntryId = `entry_first_${replaySuffix}`;
    const secondEntryId = `entry_second_${replaySuffix}`;
    const payload = approvalBrief('Replay Integrity');
    const subjectHash = hashApprovalPayload(payload);
    const unchangedRequestHash = `request_unchanged_${replaySuffix}`;
    const editRequestHash = `request_edit_${replaySuffix}`;

    await admin`insert into personas (id, display_name, role) values
      (${replayRequester}, 'Replay Requester', 'Account Owner'),
      (${firstApprover}, 'First Replay Approver', 'Deal Desk Approver'),
      (${secondApprover}, 'Second Replay Approver', 'Sales Leader')`;
    await admin`insert into accounts (id, name) values (${replayAccount}, 'Replay Integrity Account')`;
    await admin`insert into opportunities (id, account_id, name, restricted)
      values (${replayOpportunity}, ${replayAccount}, 'Replay Integrity Opportunity', false)`;
    await admin`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
      values (${runId}, ${replayOpportunity}, ${replayRequester}, 'awaiting_approval', 'mock', 'mock-brief', ${'a'.repeat(64)}, 5)`;
    await admin`insert into approval_subjects
      (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
      values (${subjectId}, ${runId}, 5, ${subjectHash}, ${JSON.stringify(payload)}::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'replay-v1')`;
    await admin`insert into approval_requirement_entries
      (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal) values
      (${firstEntryId}, ${subjectId}, 'commercial_discount', '["deal_desk"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0),
      (${secondEntryId}, ${subjectId}, 'commercial_discount', '["sales_leader"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1)`;

    const replayStore = new PostgresWorkflowStore(database);
    const unchanged = await replayStore.recordDecisionAndEnqueueFinalization({
      runId: runId as never, expectedVersion: 5, approvalSubjectId: subjectId, expectedSubjectHash: subjectHash,
      entryId: firstEntryId, category: 'commercial_discount', authority: 'deal_desk', actorId: firstApprover as never,
      idempotencyKey: `unchanged-${replaySuffix}`, requestHash: unchangedRequestHash,
      decision: {
        action: 'approve_unchanged', entryId: firstEntryId, category: 'commercial_discount', authority: 'deal_desk',
        actorId: firstApprover as never, originalPayload: payload, approvedPayload: payload, approvedSubjectHash: subjectHash,
        requestHash: unchangedRequestHash, decidedAt: new Date().toISOString()
      },
      finalizationCommand: {
        id: `command_unchanged_${replaySuffix}`, runId: runId as never, type: 'process-deal-brief-step',
        payload: { step: 'finalize' }, idempotencyKey: `finalize-unchanged-${replaySuffix}`
      }
    });
    expect(unchanged).toMatchObject({
      run: { id: runId, status: 'awaiting_approval', version: 6 },
      quorumSatisfied: false, rejected: false, replayed: false, approvedSubjectHash: subjectHash
    });

    await replayStore.replaceApprovalSubject({
      runId: runId as never, expectedVersion: 6, priorSubjectId: subjectId,
      idempotencyKey: `edit-${replaySuffix}`, requestHash: editRequestHash,
      priorDecision: {
        action: 'edit_and_approve', entryId: secondEntryId, category: 'commercial_discount', authority: 'sales_leader',
        actorId: secondApprover as never, originalPayload: payload, approvedPayload: payload, editedPayload: payload,
        approvedSubjectHash: subjectHash, diff: { changed: false }, rationale: 'Regenerate approvals.',
        requestHash: editRequestHash, decidedAt: new Date().toISOString()
      },
      subject: {
        id: replacementId, runId: runId as never, subjectHash, payload, sectionIds: [], recommendationIds: [], citationIds: [],
        policyTriggers: [], entries: [{
          id: `replacement_entry_${replaySuffix}`, category: 'commercial_discount',
          eligibleAuthorities: ['deal_desk'], policyTriggers: [], dependsOn: []
        }], quorumVersion: 'replay-v2'
      }
    });

    const replay = await replayStore.findDecisionByIdempotencyKey({
      idempotencyKey: `unchanged-${replaySuffix}`, requestHash: unchangedRequestHash
    });
    expect(replay).toMatchObject({
      run: { id: runId, status: 'awaiting_approval', version: 6 },
      approvalSubjectId: subjectId, entryId: firstEntryId, approvedSubjectHash: subjectHash,
      quorumSatisfied: false, rejected: false
    });
    await expect(replayStore.findDecisionByIdempotencyKey({
      idempotencyKey: `unchanged-${replaySuffix}`, requestHash: `mismatch-${replaySuffix}`
    })).rejects.toBeInstanceOf(DomainConflictError);
  });

  it('replays the original terminal rejection after regeneration supersedes its subject', async () => {
    const replaySuffix = crypto.randomUUID().replaceAll('-', '');
    const replayNumeric = BigInt(`0x${replaySuffix.slice(0, 15)}`).toString();
    const replayRequester = `USR-${replayNumeric}1`;
    const rejectingApprover = `USR-${replayNumeric}2`;
    const replayAccount = `ACC-${replayNumeric}`;
    const replayOpportunity = `OPP-${replayNumeric}`;
    const runId = `run_${replaySuffix}`;
    const subjectId = `approval_subject_${replaySuffix}`;
    const regeneratedSubjectId = `approval_subject_regenerated_${replaySuffix}`;
    const entryId = `entry_reject_${replaySuffix}`;
    const payload = approvalBrief('Rejected Replay Integrity');
    const subjectHash = hashApprovalPayload(payload);
    const rejectRequestHash = `request_reject_${replaySuffix}`;

    await admin`insert into personas (id, display_name, role) values
      (${replayRequester}, 'Rejected Replay Requester', 'Account Owner'),
      (${rejectingApprover}, 'Rejecting Replay Approver', 'Deal Desk Approver')`;
    await admin`insert into accounts (id, name) values (${replayAccount}, 'Rejected Replay Account')`;
    await admin`insert into opportunities (id, account_id, name, restricted)
      values (${replayOpportunity}, ${replayAccount}, 'Rejected Replay Opportunity', false)`;
    await admin`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
      values (${runId}, ${replayOpportunity}, ${replayRequester}, 'awaiting_approval', 'mock', 'mock-brief', ${'b'.repeat(64)}, 11)`;
    await admin`insert into approval_subjects
      (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
      values (${subjectId}, ${runId}, 11, ${subjectHash}, ${JSON.stringify(payload)}::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'replay-v1')`;
    await admin`insert into approval_requirement_entries
      (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
      values (${entryId}, ${subjectId}, 'commercial_discount', '["deal_desk"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0)`;

    const replayStore = new PostgresWorkflowStore(database);
    const rejection = await replayStore.recordDecisionAndEnqueueFinalization({
      runId: runId as never, expectedVersion: 11, approvalSubjectId: subjectId, expectedSubjectHash: subjectHash,
      entryId, category: 'commercial_discount', authority: 'deal_desk', actorId: rejectingApprover as never,
      idempotencyKey: `reject-${replaySuffix}`, requestHash: rejectRequestHash,
      decision: {
        action: 'reject', entryId, category: 'commercial_discount', authority: 'deal_desk',
        actorId: rejectingApprover as never, originalPayload: payload, approvedPayload: payload, approvedSubjectHash: subjectHash,
        rationale: 'The commercial position is not acceptable.', requestHash: rejectRequestHash, decidedAt: new Date().toISOString()
      },
      finalizationCommand: {
        id: `command_reject_${replaySuffix}`, runId: runId as never, type: 'process-deal-brief-step',
        payload: { step: 'finalize' }, idempotencyKey: `finalize-reject-${replaySuffix}`
      }
    });
    expect(rejection).toMatchObject({
      run: { id: runId, status: 'rejected', version: 12 },
      quorumSatisfied: false, rejected: true, replayed: false, approvedSubjectHash: subjectHash
    });

    await replayStore.regenerateRun({
      runId: runId as never, expectedVersion: 12, requestedBy: replayRequester as never,
      idempotencyKey: `regenerate-${replaySuffix}`, requestHash: `request_regenerate_${replaySuffix}`,
      command: {
        id: `command_regenerate_${replaySuffix}`, runId: runId as never, type: 'process-deal-brief-step',
        payload: { step: 'synthesize' }, idempotencyKey: `regenerate-command-${replaySuffix}`
      }
    });
    await admin`insert into approval_subjects
      (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
      values (${regeneratedSubjectId}, ${runId}, 13, ${subjectHash}, ${JSON.stringify(payload)}::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'replay-v2')`;
    await admin`update approval_subjects set superseded_by_subject_id = ${regeneratedSubjectId} where id = ${subjectId}`;

    const replay = await replayStore.findDecisionByIdempotencyKey({
      idempotencyKey: `reject-${replaySuffix}`, requestHash: rejectRequestHash
    });
    expect(replay).toMatchObject({
      run: { id: runId, status: 'rejected', version: 12 },
      approvalSubjectId: subjectId, entryId, approvedSubjectHash: subjectHash,
      quorumSatisfied: false, rejected: true
    });
  });
});
