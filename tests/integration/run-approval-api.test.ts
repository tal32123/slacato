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
const personaBase = 9_000_000 + process.pid * 3;
const ids = {
  account: `ACC-${suffix}`,
  hiddenAccount: `ACC-hidden-${suffix}`,
  opportunity: `OPP-${suffix}`,
  hiddenOpportunity: `OPP-hidden-${suffix}`,
  requester: `USR-${personaBase}`,
  approver: `USR-${personaBase + 1}`,
  outsider: `USR-${personaBase + 2}`,
  run: `run-${suffix}`,
  hiddenRun: `run-hidden-${suffix}`,
  subject: `subject-${suffix}`,
  entry: `entry-${suffix}`,
  replacementSubject: `subject-replacement-${suffix}`,
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
  sourceEvidence: { evidence: [] },
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

describe('run and approval query APIs', () => {
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
      (${ids.outsider}, 'Task 13 Outsider', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT})`;
    await sql`insert into permission_grants
      (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing, source_commit)
      values
      (${`grant-requester-${suffix}`}, ${ids.requester}, ${ids.account}, 'salesforce', true, false, true, false, false, ${CANONICAL_FIXTURE_COMMIT})`;
    await sql`insert into approval_authority_grants (id, persona_id, account_id, authority, source)
      values (${`authority-${suffix}`}, ${ids.approver}, ${ids.account}, 'legal_reviewer', 'task-13-test')`;
    await sql`insert into runs
      (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
      values
      (${ids.run}, ${ids.opportunity}, ${ids.requester}, 'awaiting_approval', 'mock', 'mock-brief', ${'c'.repeat(64)}, 7),
      (${ids.hiddenRun}, ${ids.hiddenOpportunity}, ${ids.requester}, 'completed', 'mock', 'mock-brief', ${'d'.repeat(64)}, 4)`;
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
    expect(list.runs.map(({ runId }) => runId)).toEqual([ids.run]);
    expect(JSON.stringify(list)).not.toContain(ids.hiddenRun);

    const approver = await authenticate(app, ids.approver);
    const detail = runDetailResponseSchema.parse((await approver.get(`/api/runs/${ids.run}/detail`).set(browserHeaders).expect(200)).body);
    expect(detail).toMatchObject({ runId: ids.run, status: 'awaiting_approval', watermarkSequence: 2, terminal: false });
    expect(detail.progress.timeline.map(({ sequence }) => sequence)).toEqual([1, 2]);
    const snapshot = runSnapshotSchema.parse((await approver.get(`/api/runs/${ids.run}`).set(browserHeaders).expect(200)).body);
    expect(snapshot.watermark).toBe(`event-2-${suffix}`);
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
  });
});
