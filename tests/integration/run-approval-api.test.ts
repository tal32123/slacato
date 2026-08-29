import type { NestExpressApplication } from '@nestjs/platform-express';
import { CANONICAL_FIXTURE_COMMIT, hashApprovalPayload } from '@slacato/core';
import { approvalDetailResponseSchema, approvalInboxResponseSchema, runDetailResponseSchema, runListResponseSchema, runSnapshotSchema } from '@slacato/contracts';
import postgres, { type Sql } from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/main';

const origin = 'http://127.0.0.1:4173';
const browserHeaders = { Origin: origin, 'Sec-Fetch-Site': 'same-site' };
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const suffix = `task13_${process.pid}`;
const personaBase = 9_000_000 + process.pid * 10;
const ids = {
  account: `ACC-${suffix}`,
  hiddenAccount: `ACC-hidden-${suffix}`,
  opportunity: `OPP-${suffix}`,
  hiddenOpportunity: `OPP-hidden-${suffix}`,
  requester: `USR-${personaBase}`,
  approver: `USR-${personaBase + 1}`,
  outsider: `USR-${personaBase + 2}`,
  reader: `USR-${personaBase + 3}`,
  stale: `USR-${personaBase + 4}`,
  wrongAuthority: `USR-${personaBase + 5}`,
  run: `run-${suffix}`,
  hiddenRun: `run-hidden-${suffix}`,
  failedRun: `run-failed-${suffix}`,
  subject: `subject-${suffix}`,
  entry: `entry-${suffix}`,
  replacementSubject: `subject-replacement-${suffix}`,
  crmEvidence: `evidence_crm_${suffix}`,
  restrictedConversationEvidence: `evidence_conversation_${suffix}`,
  deadEvidence: `evidence_dead_${suffix}`,
  replacementEntry: `entry-replacement-${suffix}`
} as const;
const subjectPayload = {
  dealSnapshot: { accountName: 'Task 13 Account', opportunityName: 'Task 13 Renewal', stage: 'Negotiation' },
  executiveSummary: { narrative: 'A validated summary for approval.' },
  buyerGoalsAndBusinessDrivers: { goals: ['Renew safely'], businessDrivers: ['Continuity'] },
  stakeholderMap: { stakeholders: [] },
  negotiationState: { currentState: 'Legal terms require review.', risks: ['Approval outstanding'] },
  recommendedNextActions: { actions: [] },
  missingInformation: { items: [] },
  sourceEvidence: { evidence: [
    { evidenceId: ids.crmEvidence, sourceType: 'crm', summary: 'Readable CRM evidence summary.', capturedAt: '2026-08-29T10:00:00.000Z', claims: [] },
    { evidenceId: ids.restrictedConversationEvidence, sourceType: 'conversation', summary: 'Restricted conversation summary.', capturedAt: '2026-08-29T11:00:00.000Z', claims: [] },
    { evidenceId: ids.deadEvidence, sourceType: 'conversation', summary: 'No persisted evidence row.', capturedAt: '2026-08-29T12:00:00.000Z', claims: [] }
  ] },
  confidenceAndReviewWarnings: { overallConfidence: 0.8, warnings: [] }
};
const subjectHash = hashApprovalPayload(subjectPayload);
const replacementPayload = {
  ...subjectPayload,
  confidenceAndReviewWarnings: { overallConfidence: 0.7, warnings: [] }
};
const replacementSubjectHash = hashApprovalPayload(replacementPayload);

async function authenticate(app: NestExpressApplication, userId: string) {
  const agent = request.agent(app.getHttpServer());
  const bootstrap = await agent.get('/api/auth/csrf').set(browserHeaders).expect(200);
  await agent.post('/api/auth/persona').set(browserHeaders)
    .set('X-CSRF-Token', bootstrap.body.csrfToken as string).send({ userId }).expect(201);
  return agent;
}

async function authenticateWithCsrf(app: NestExpressApplication, userId: string) {
  const agent = request.agent(app.getHttpServer());
  const bootstrap = await agent.get('/api/auth/csrf').set(browserHeaders).expect(200);
  const selected = await agent.post('/api/auth/persona').set(browserHeaders)
    .set('X-CSRF-Token', bootstrap.body.csrfToken as string).send({ userId }).expect(201);
  return { agent, csrfToken: selected.body.csrfToken as string };
}

describe.sequential('run and approval query APIs', () => {
  let app: NestExpressApplication;
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(databaseUrl, { max: 1 });
    await sql`insert into accounts (id, name) values (${ids.account}, 'Task 13 Account'), (${ids.hiddenAccount}, 'Hidden Account')`;
    await sql`insert into opportunities (id, account_id, name, restricted) values
      (${ids.opportunity}, ${ids.account}, 'Task 13 Renewal', false),
      (${ids.hiddenOpportunity}, ${ids.hiddenAccount}, 'Hidden Renewal', false)`;
    await sql`insert into personas (id, display_name, role, source_commit) values
      (${ids.requester}, 'Task 13 Requester', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT}),
      (${ids.approver}, 'Task 13 Legal Reviewer', 'Legal Reviewer', ${CANONICAL_FIXTURE_COMMIT}),
      (${ids.outsider}, 'Task 13 Outsider', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT}),
      (${ids.reader}, 'Task 13 Reader', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT}),
      (${ids.stale}, 'Task 13 Stale Grant', 'Legal Reviewer', ${CANONICAL_FIXTURE_COMMIT}),
      (${ids.wrongAuthority}, 'Task 13 Wrong Authority', 'Deal Desk Approver', ${CANONICAL_FIXTURE_COMMIT})`;
    await sql`insert into permission_grants
      (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing, source_commit)
      values
      (${`grant-requester-${suffix}`}, ${ids.requester}, ${ids.account}, 'salesforce', true, false, true, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      (${`grant-reader-${suffix}`}, ${ids.reader}, ${ids.account}, 'salesforce', true, false, true, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      (${`grant-stale-${suffix}`}, ${ids.stale}, ${ids.account}, 'salesforce', true, true, true, true, true, ${'a'.repeat(40)})`;
    await sql`insert into approval_authority_grants (id, persona_id, account_id, authority, source, source_commit)
      values
      (${`authority-${suffix}`}, ${ids.approver}, ${ids.account}, 'legal_reviewer', 'task-13-test', ${CANONICAL_FIXTURE_COMMIT}),
      (${`authority-stale-${suffix}`}, ${ids.stale}, ${ids.account}, 'legal_reviewer', 'old-task-13-test', ${'a'.repeat(40)}),
      (${`authority-wrong-${suffix}`}, ${ids.wrongAuthority}, ${ids.account}, 'deal_desk', 'task-13-test', ${CANONICAL_FIXTURE_COMMIT})`;
    await sql`insert into permission_grants
      (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing, source_commit)
      values
      (${`grant-approver-crm-${suffix}`}, ${ids.approver}, ${ids.account}, 'salesforce', true, false, false, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      (${`grant-approver-conversation-${suffix}`}, ${ids.approver}, ${ids.account}, 'gong_summary', true, false, false, false, false, ${CANONICAL_FIXTURE_COMMIT})`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content)
      values
      (${`document-crm-${suffix}`}, ${`document-crm-${suffix}`}, 1, 'salesforce', ${`document-crm-hash-${suffix}`}, 'CRM fixture'),
      (${`document-conversation-${suffix}`}, ${`document-conversation-${suffix}`}, 1, 'gong_summary', ${`document-conversation-hash-${suffix}`}, 'Conversation fixture')`;
    await sql`insert into evidence_versions
      (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content,
        event_date, source_locator, reliability_class, classification_reason, policy_hash)
      values
      (${ids.crmEvidence}, ${`document-crm-${suffix}`}, ${ids.account}, ${ids.opportunity}, 0, 'salesforce', 'standard', ${`evidence-crm-hash-${suffix}`}, 'Readable CRM fixture', '2026-08-29', 'salesforce/opportunities.tsv#task13:0', 'authoritative_system', 'task13_test', ${'a'.repeat(64)}),
      (${ids.restrictedConversationEvidence}, ${`document-conversation-${suffix}`}, ${ids.account}, ${ids.opportunity}, 0, 'gong_summary', 'restricted', ${`evidence-conversation-hash-${suffix}`}, 'Restricted conversation fixture', '2026-08-29', 'gong/calls.json#task13:0', 'direct_conversation', 'task13_test', ${'a'.repeat(64)})`;
    await sql`insert into runs
      (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
      values
      (${ids.run}, ${ids.opportunity}, ${ids.requester}, 'awaiting_approval', 'mock', 'mock-brief', ${'c'.repeat(64)}, 7),
      (${ids.hiddenRun}, ${ids.hiddenOpportunity}, ${ids.requester}, 'completed', 'mock', 'mock-brief', ${'d'.repeat(64)}, 4),
      (${ids.failedRun}, ${ids.opportunity}, ${ids.requester}, 'failed', 'mock', 'mock-brief', ${'e'.repeat(64)}, 3)`;
    await sql`insert into workflow_checkpoints (id, run_id, step, payload)
      values (${`checkpoint-strategy-${suffix}`}, ${ids.failedRun}, 'strategy:1', ${sql.json({ status: 'completed', value: subjectPayload })})`;
    await sql`insert into run_events (id, run_id, sequence, type, payload) values
      (${`event-1-${suffix}`}, ${ids.run}, 1, 'run_created', ${sql.json({ status: 'created', deadlineMs: 60000 })}),
      (${`event-2-${suffix}`}, ${ids.run}, 2, 'awaiting_approval', ${sql.json({ version: 7, subjectHash, quorumVersion: 'deal-brief-approval-v1' })})`;
    await sql`insert into approval_subjects
      (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
      values (${ids.subject}, ${ids.run}, 1, ${subjectHash}, ${sql.json(subjectPayload)}, ${sql.json(['section:executiveSummary'])}, ${sql.json([])}, ${sql.json([])}, ${sql.json(['legal_terms'])}, 'deal-brief-approval-v1')`;
    await sql`insert into approval_requirement_entries
      (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
      values (${ids.entry}, ${ids.subject}, 'legal_terms', ${sql.json(['legal_reviewer'])}, ${sql.json(['legal_terms'])}, ${sql.json([])}, 0)`;
    app = await createApiApplication({ environment: {
      ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl,
      SESSION_SECRET: 'task-13-query-api-session-secret-long-enough', AI_PROVIDER: 'mock', WEB_ORIGIN: origin
    } });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 1 });
  });

  it('lists complete scoped runs and lets an authorized approval actor rejoin the persisted detail and watermark', async () => {
    const requester = await authenticate(app, ids.requester);
    const list = runListResponseSchema.parse((await requester.get('/api/runs').set(browserHeaders).expect(200)).body);
    expect(list.runs.map(({ runId }) => runId)).toEqual(expect.arrayContaining([ids.run, ids.failedRun]));
    expect(JSON.stringify(list)).not.toContain(ids.hiddenRun);

    const approver = await authenticate(app, ids.approver);
    const detail = runDetailResponseSchema.parse((await approver.get(`/api/runs/${ids.run}/detail`).set(browserHeaders).expect(200)).body);
    expect(detail).toMatchObject({ runId: ids.run, status: 'awaiting_approval', watermarkSequence: 2, terminal: false });
    expect(detail.progress.timeline.map(({ sequence }) => sequence)).toEqual([1, 2]);
    const snapshot = runSnapshotSchema.parse((await approver.get(`/api/runs/${ids.run}`).set(browserHeaders).expect(200)).body);
    expect(snapshot.watermark).toBe(`event-2-${suffix}`);
  });
  it('returns an existing active run to every canonical readable starter and rejects stale grant provenance across boundaries', async () => {
    const reader = await authenticateWithCsrf(app, ids.reader);
    const start = await reader.agent.post('/api/runs/deal-brief').set(browserHeaders)
      .set('X-CSRF-Token', reader.csrfToken).send({
        opportunityId: ids.opportunity,
        idempotencyKey: `reader-start-${suffix}`,
        budget: { maxCalls: 10, maxInputTokens: 10_000, maxOutputTokens: 5_000, deadlineMs: 60_000 }
      }).expect(201);
    expect(start.body).toEqual({ runId: ids.run });
    expect((await reader.agent.get('/api/runs').set(browserHeaders).expect(200)).body.runs)
      .toEqual(expect.arrayContaining([expect.objectContaining({ runId: ids.run })]));
    await reader.agent.get(`/api/runs/${ids.run}/detail`).set(browserHeaders).expect(200);
    await reader.agent.get(`/api/runs/${ids.run}`).set(browserHeaders).expect(200);
    const failed = (await reader.agent.get(`/api/runs/${ids.failedRun}/detail`).set(browserHeaders).expect(200)).body;
    expect(failed.progress.completedSections).toEqual([]);

    const stale = await authenticateWithCsrf(app, ids.stale);
    const staleStart = await stale.agent.post('/api/runs/deal-brief').set(browserHeaders)
      .set('X-CSRF-Token', stale.csrfToken).send({
        opportunityId: ids.opportunity,
        idempotencyKey: `stale-start-${suffix}`,
        budget: { maxCalls: 10, maxInputTokens: 10_000, maxOutputTokens: 5_000, deadlineMs: 60_000 }
      }).expect(404);
    const missingStart = await stale.agent.post('/api/runs/deal-brief').set(browserHeaders)
      .set('X-CSRF-Token', stale.csrfToken).send({
        opportunityId: `OPP-missing-${suffix}`,
        idempotencyKey: `missing-start-${suffix}`,
        budget: { maxCalls: 10, maxInputTokens: 10_000, maxOutputTokens: 5_000, deadlineMs: 60_000 }
      }).expect(404);
    expect(staleStart.body).toEqual(missingStart.body);
    expect((await stale.agent.get('/api/approvals').set(browserHeaders).expect(200)).body.pending).toEqual([]);
    await stale.agent.get(`/api/runs/${ids.run}`).set(browserHeaders).expect(404);
    await stale.agent.get(`/api/approvals/${ids.subject}`).set(browserHeaders).expect(404);
    const decision = {
      runId: ids.run, approvalSubjectId: ids.subject, expectedRunVersion: 7, expectedSubjectHash: subjectHash,
      entryId: ids.entry, category: 'legal_terms', authority: 'legal_reviewer',
      action: 'approve_unchanged', idempotencyKey: `stale-decision-${suffix}`
    };
    const staleDecision = await stale.agent.post('/api/approvals/decisions').set(browserHeaders)
      .set('X-CSRF-Token', stale.csrfToken).send(decision).expect(404);
    const outsider = await authenticateWithCsrf(app, ids.outsider);
    const outsiderDecision = await outsider.agent.post('/api/approvals/decisions').set(browserHeaders)
      .set('X-CSRF-Token', outsider.csrfToken)
      .send({ ...decision, runId: `run-missing-${suffix}`, idempotencyKey: `missing-decision-${suffix}` }).expect(404);
    expect(staleDecision.body).toEqual(outsiderDecision.body);
  });


  it('returns one opaque response for missing and unauthorized run and approval deep links', async () => {
    const outsider = await authenticate(app, ids.outsider);
    for (const path of [
      `/api/runs/${ids.run}/detail`,
      '/api/runs/run-does-not-exist/detail',
      `/api/approvals/${ids.subject}`,
      '/api/approvals/subject-does-not-exist'
    ]) {
      const response = await outsider.get(path).set(browserHeaders).expect(404);
      expect(response.body).toEqual({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
      expect(JSON.stringify(response.body)).not.toContain(ids.run);
    }
  });

  it('orders authority-scoped pending approvals before history and exposes only actor-operable entries', async () => {
    const approver = await authenticate(app, ids.approver);
    const inbox = approvalInboxResponseSchema.parse((await approver.get('/api/approvals').set(browserHeaders).expect(200)).body);
    expect(inbox.pending).toEqual([expect.objectContaining({
      approvalSubjectId: ids.subject, runId: ids.run, entryId: ids.entry,
      availableAuthority: 'legal_reviewer', decision: null
    })]);
    expect(inbox.history).toEqual([]);

    await sql`insert into approval_subjects
      (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
      values (${ids.replacementSubject}, ${ids.run}, 2, ${replacementSubjectHash}, ${sql.json(replacementPayload)},
        ${sql.json(['section:executiveSummary'])}, ${sql.json([])}, ${sql.json([])}, ${sql.json(['legal_terms'])}, 'deal-brief-approval-v1')`;
    await sql`update approval_subjects set superseded_by_subject_id = ${ids.replacementSubject} where id = ${ids.subject}`;
    await sql`insert into approval_requirement_entries
      (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
      values (${ids.replacementEntry}, ${ids.replacementSubject}, 'legal_terms', ${sql.json(['legal_reviewer'])},
        ${sql.json(['legal_terms'])}, ${sql.json([])}, 0)`;
    const afterEdit = approvalInboxResponseSchema.parse((await approver.get('/api/approvals').set(browserHeaders).expect(200)).body);
    expect(afterEdit.pending.map(({ approvalSubjectId, entryId }) => ({ approvalSubjectId, entryId }))).toEqual([{
      approvalSubjectId: ids.replacementSubject,
      entryId: ids.replacementEntry
    }]);

    const detail = approvalDetailResponseSchema.parse((await approver.get(`/api/approvals/${ids.subject}`).set(browserHeaders).expect(200)).body);
    expect(detail.entries).toEqual([expect.objectContaining({ entryId: ids.entry, availableAuthority: 'legal_reviewer', decided: false })]);
    expect(detail.payload.executiveSummary.narrative).toBe('A validated summary for approval.');
    expect(detail.capabilities).toEqual({ canReadDeal: true, evidenceIds: [ids.crmEvidence] });
  });
  it('authorizes the exact current entry before exposing stale subject conflicts', async () => {
    const opaqueBody = { code: 'NOT_FOUND', message: 'The requested resource was not found.' };
    const wrongAuthority = await authenticateWithCsrf(app, ids.wrongAuthority);
    const wrongInput = {
      runId: ids.run,
      approvalSubjectId: ids.replacementSubject,
      expectedRunVersion: 7,
      expectedSubjectHash: '0'.repeat(64),
      entryId: ids.replacementEntry,
      category: 'legal_terms',
      authority: 'deal_desk',
      action: 'approve_unchanged',
      idempotencyKey: `wrong-authority-${suffix}`
    };
    const wrong = await wrongAuthority.agent.post('/api/approvals/decisions').set(browserHeaders)
      .set('X-CSRF-Token', wrongAuthority.csrfToken).send(wrongInput).expect(404);
    const missing = await wrongAuthority.agent.post('/api/approvals/decisions').set(browserHeaders)
      .set('X-CSRF-Token', wrongAuthority.csrfToken)
      .send({ ...wrongInput, approvalSubjectId: `subject-missing-${suffix}`, idempotencyKey: `wrong-missing-${suffix}` }).expect(404);
    const authorized = await authenticateWithCsrf(app, ids.approver);
    const superseded = await authorized.agent.post('/api/approvals/decisions').set(browserHeaders)
      .set('X-CSRF-Token', authorized.csrfToken).send({
        ...wrongInput,
        approvalSubjectId: ids.subject,
        entryId: ids.entry,
        authority: 'legal_reviewer',
        idempotencyKey: `authorized-superseded-${suffix}`
      }).expect(404);
    expect(wrong.body).toEqual(opaqueBody);
    expect(missing.body).toEqual(opaqueBody);
    expect(superseded.body).toEqual(opaqueBody);
    await authorized.agent.post('/api/approvals/decisions').set(browserHeaders)
      .set('X-CSRF-Token', authorized.csrfToken).send({
        ...wrongInput,
        authority: 'legal_reviewer',
        idempotencyKey: `authorized-stale-${suffix}`
      }).expect(409);
  });
});
