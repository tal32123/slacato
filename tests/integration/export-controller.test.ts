import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CANONICAL_FIXTURE_COMMIT, exportBrief, hashApprovalPayload } from '@slacato/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/main';

const origin = 'http://127.0.0.1:4173';
const browserHeaders = { Origin: origin, 'Sec-Fetch-Site': 'same-site' };
const rootDatabaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const suffix = `task14_${process.pid}`;
const databaseName = `catohw_${suffix}`;
const isolatedDatabaseUrl = new URL(rootDatabaseUrl);
isolatedDatabaseUrl.pathname = `/${databaseName}`;
const personaBase = 80_000_000 + process.pid * 10;
const ids = {
  account: `ACC-${personaBase}`,
  opportunity: `OPP-${personaBase}`,
  reader: `USR-${personaBase}`,
  citationDenied: `USR-${personaBase + 1}`,
  authorityOnly: `USR-${personaBase + 2}`,
  outsider: `USR-${personaBase + 3}`,
  run: `run_${suffix}`,
  unboundRun: `run_${suffix}_unbound`,
  authorityRun: `run_${suffix}_authority_only`,
  subject: `subject_${suffix}`,
  requirement: `requirement_${suffix}`,
  authoritySubject: `subject_${suffix}_authority_only`,
  authorityRequirement: `requirement_${suffix}_authority_only`,
  crmEvidence: `evidence_${suffix}_crm`,
  restrictedEvidence: `evidence_${suffix}_restricted`,
  crmCitation: `citation_${suffix}_crm`,
  restrictedCitation: `citation_${suffix}_restricted`
} as const;

const claim = {
  id: `claim_${suffix}_summary`,
  statement: 'The renewal is in negotiation.',
  confidence: 0.9,
  citations: [
    { id: ids.crmCitation, evidenceId: ids.crmEvidence, locator: 'salesforce/opportunities.tsv#renewal' },
    { id: ids.restrictedCitation, evidenceId: ids.restrictedEvidence, locator: 'gong/calls.json#renewal' }
  ]
};
const brief = {
  dealSnapshot: {
    accountName: 'Task 14 Account', opportunityName: 'Task 14 Renewal', stage: 'Negotiation',
    closeDate: '2026-09-30', amount: 125000, currency: 'USD', owner: 'Avery Owner', claims: [claim]
  },
  executiveSummary: { narrative: 'A deterministic approved brief.', claims: [claim] },
  buyerGoalsAndBusinessDrivers: { goals: ['Renew safely'], businessDrivers: ['Continuity'], claims: [claim] },
  stakeholderMap: {
    stakeholders: [{
      name: 'Casey Buyer', title: 'VP Finance', organization: 'Task 14 Account', role: 'economic_buyer' as const,
      influence: 'high' as const, relationship: 'positive' as const, goals: ['Continuity'], concerns: ['Timing'], claims: [claim]
    }],
    coverageGaps: ['Legal reviewer'], claims: [claim]
  },
  negotiationState: { currentState: 'Negotiation is active.', leverage: ['Renewal timing'], risks: ['Legal timing'], claims: [claim] },
  recommendedNextActions: { actions: [{ action: 'Schedule review', owner: 'Avery Owner', priority: 'high' as const, rationale: 'Resolve timing.', dueDate: '2026-09-01', claims: [claim] }] },
  missingInformation: { items: [{ question: 'Who signs?', whyItMatters: 'Confirms process.', owner: 'Avery Owner' }] },
  sourceEvidence: { evidence: [
    { evidenceId: ids.crmEvidence, sourceType: 'crm' as const, summary: 'CRM opportunity summary.', capturedAt: '2026-08-29T10:00:00.000Z', claims: [claim] },
    { evidenceId: ids.restrictedEvidence, sourceType: 'conversation' as const, summary: 'Authorized conversation summary.', capturedAt: '2026-08-29T11:00:00.000Z', claims: [claim] }
  ] },
  confidenceAndReviewWarnings: { overallConfidence: 0.9, warnings: [{ code: 'HUMAN_REVIEW', severity: 'warning' as const, message: 'Confirm legal timing.', claimIds: [claim.id] }] }
};
const subjectHash = hashApprovalPayload(brief);
const noReferenceBrief = {
  dealSnapshot: { accountName: 'Task 14 Account', opportunityName: 'Task 14 Renewal', stage: 'Negotiation' },
  executiveSummary: { narrative: 'A finalized brief without evidence references.' },
  buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
  stakeholderMap: { stakeholders: [] },
  negotiationState: { currentState: 'Negotiation is active.', risks: [] },
  recommendedNextActions: { actions: [] },
  missingInformation: { items: [] },
  sourceEvidence: { evidence: [] },
  confidenceAndReviewWarnings: { overallConfidence: 0.5, warnings: [] }
};
const noReferenceSubjectHash = hashApprovalPayload(noReferenceBrief);

async function authenticate(app: NestExpressApplication, userId: string) {
  const agent = request.agent(app.getHttpServer());
  const bootstrap = await agent.get('/api/auth/csrf').set(browserHeaders).expect(200);
  await agent.post('/api/auth/persona').set(browserHeaders)
    .set('X-CSRF-Token', bootstrap.body.csrfToken as string).send({ userId }).expect(201);
  return agent;
}

describe.sequential('authorized finalized brief exports', () => {
  let app: NestExpressApplication;
  let sql: Sql;
  let admin: Sql;

  beforeAll(async () => {
    admin = postgres(rootDatabaseUrl, { max: 1 });
    await admin.unsafe(`create database \"${databaseName}\"`);
    sql = postgres(isolatedDatabaseUrl.toString(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    await sql`insert into accounts (id, name) values (${ids.account}, 'Task 14 Account')`;
    await sql`insert into opportunities (id, account_id, name, restricted) values (${ids.opportunity}, ${ids.account}, 'Task 14 Renewal', false)`;
    await sql`insert into personas (id, display_name, role, source_commit) values
      (${ids.reader}, 'Task 14 Reader', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT}),
      (${ids.citationDenied}, 'Task 14 Partial Reader', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT}),
      (${ids.authorityOnly}, 'Task 14 Authority Only', 'Legal Reviewer', ${CANONICAL_FIXTURE_COMMIT}),
      (${ids.outsider}, 'Task 14 Outsider', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT})`;
    await sql`insert into permission_grants
      (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing, source_commit)
      values
      (${`grant_${suffix}_reader_crm`}, ${ids.reader}, ${ids.account}, 'salesforce', true, false, true, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      (${`grant_${suffix}_reader_gong`}, ${ids.reader}, ${ids.account}, 'gong_summary', true, true, true, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      (${`grant_${suffix}_partial_crm`}, ${ids.citationDenied}, ${ids.account}, 'salesforce', true, false, true, false, false, ${CANONICAL_FIXTURE_COMMIT})`;
    await sql`insert into approval_authority_grants (id, persona_id, account_id, authority, source, source_commit)
      values (${`authority_${suffix}`}, ${ids.authorityOnly}, ${ids.account}, 'legal_reviewer', 'task-14-test', ${CANONICAL_FIXTURE_COMMIT})`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content)
      values
      (${`document_${suffix}_crm`}, ${`external_${suffix}_crm`}, 1, 'salesforce', ${`hash_${suffix}_crm`}, 'RAW_CRM_SOURCE_SENTINEL'),
      (${`document_${suffix}_gong`}, ${`external_${suffix}_gong`}, 1, 'gong_summary', ${`hash_${suffix}_gong`}, 'RAW_GONG_SOURCE_SENTINEL')`;
    await sql`insert into evidence_versions
      (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content,
        event_date, source_locator, reliability_class, classification_reason, policy_hash)
      values
      (${ids.crmEvidence}, ${`document_${suffix}_crm`}, ${ids.account}, ${ids.opportunity}, 0, 'salesforce', 'standard', ${`evidence_hash_${suffix}_crm`}, 'RAW_CRM_EVIDENCE_SENTINEL', '2026-08-29', 'salesforce/opportunities.tsv#renewal', 'authoritative_system', 'task14_test', ${'a'.repeat(64)}),
      (${ids.restrictedEvidence}, ${`document_${suffix}_gong`}, ${ids.account}, ${ids.opportunity}, 0, 'gong_summary', 'restricted', ${`evidence_hash_${suffix}_gong`}, 'RAW_GONG_EVIDENCE_SENTINEL', '2026-08-29', 'gong/calls.json#renewal', 'direct_conversation', 'task14_test', ${'a'.repeat(64)})`;
    await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
      values
      (${ids.run}, ${ids.opportunity}, ${ids.reader}, 'completed', 'mock', 'mock-brief', ${'b'.repeat(64)}, 4),
      (${ids.unboundRun}, ${ids.opportunity}, ${ids.reader}, 'completed', 'mock', 'mock-brief', ${'c'.repeat(64)}, 1),
      (${ids.authorityRun}, ${ids.opportunity}, ${ids.reader}, 'completed', 'mock', 'mock-brief', ${'1'.repeat(64)}, 2)`;
    await sql`insert into run_evidence_manifests
      (id, run_id, scope_hash, policy_hash, query_hash, index_profile, embedding_provider, embedding_model,
        embedding_dimension, embedding_version, embedding_normalization, context_limit, diagnostics)
      values (${`manifest_${suffix}`}, ${ids.run}, ${'d'.repeat(64)}, ${'e'.repeat(64)}, ${'f'.repeat(64)},
        'task14-index', 'mock', 'mock-embedding', 64, 'v1', 'l2', 60000, '{}'::jsonb)`;
    await sql`insert into run_evidence_manifest_entries
      (manifest_id, evidence_version_id, citation_id, rank, query_rank, score, content_hash, source_locator,
        source_type, sensitivity, classification_reason, policy_hash, lexical_rank, semantic_rank, fusion_score,
        reliability_adjustment, recency_adjustment, included_characters)
      values
      (${`manifest_${suffix}`}, ${ids.crmEvidence}, ${ids.crmCitation}, 1, 1, 1, ${`evidence_hash_${suffix}_crm`},
        'salesforce/opportunities.tsv#renewal', 'salesforce', 'standard', 'task14_test', ${'a'.repeat(64)}, 1, 1, 1, 1, 1, 100),
      (${`manifest_${suffix}`}, ${ids.restrictedEvidence}, ${ids.restrictedCitation}, 2, 2, 0.9, ${`evidence_hash_${suffix}_gong`},
        'gong/calls.json#renewal', 'gong_summary', 'restricted', 'task14_test', ${'a'.repeat(64)}, 2, 2, 0.9, 1, 1, 100)`;
    await sql`insert into approval_subjects
      (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
      values
      (${ids.subject}, ${ids.run}, 1, ${subjectHash}, ${JSON.stringify(brief)}::jsonb, '[]'::jsonb, '[]'::jsonb, ${JSON.stringify([ids.crmCitation, ids.restrictedCitation])}::jsonb, '[\"legal_terms\"]'::jsonb, 'deal-brief-approval-v1'),
      (${ids.authoritySubject}, ${ids.authorityRun}, 1, ${noReferenceSubjectHash}, ${JSON.stringify(noReferenceBrief)}::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[\"legal_terms\"]'::jsonb, 'deal-brief-approval-v1')`;
    await sql`insert into approval_requirement_entries
      (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
      values
      (${ids.requirement}, ${ids.subject}, 'legal_terms', '[\"legal_reviewer\"]'::jsonb, '[\"legal_terms\"]'::jsonb, '[]'::jsonb, 0),
      (${ids.authorityRequirement}, ${ids.authoritySubject}, 'legal_terms', '[\"legal_reviewer\"]'::jsonb, '[\"legal_terms\"]'::jsonb, '[]'::jsonb, 0)`;
    await sql`insert into briefs (id, run_id, approval_subject_id, draft_version, payload, subject_hash, finalized_at)
      values
      (${`brief_${suffix}`}, ${ids.run}, ${ids.subject}, 1, ${JSON.stringify(brief)}::jsonb, ${subjectHash}, now()),
      (${`brief_${suffix}_unbound`}, ${ids.unboundRun}, null, 0, ${JSON.stringify(brief)}::jsonb, ${subjectHash}, now()),
      (${`brief_${suffix}_authority_only`}, ${ids.authorityRun}, ${ids.authoritySubject}, 1, ${JSON.stringify(noReferenceBrief)}::jsonb, ${noReferenceSubjectHash}, now())`;

    app = await createApiApplication({ environment: {
      ...process.env, NODE_ENV: 'test', DATABASE_URL: isolatedDatabaseUrl.toString(),
      SESSION_SECRET: 'task-14-export-session-secret-long-enough', AI_PROVIDER: 'mock', WEB_ORIGIN: origin
    } });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 1 });
    if (admin !== undefined) {
      await admin.unsafe(`drop database if exists \"${databaseName}\" with (force)`);
      await admin.end({ timeout: 1 });
    }
  });

  it('serializes canonical JSON and deterministic Markdown with all nine sections and citation labels', () => {
    const json = exportBrief(brief, 'json');
    expect(JSON.parse(json)).toEqual(brief);
    expect(exportBrief(brief, 'json')).toBe(json);

    const markdown = exportBrief(brief, 'markdown');
    expect(exportBrief(brief, 'markdown')).toBe(markdown);
    expect(markdown.match(/^## \d+\. /gm)).toHaveLength(9);
    expect(markdown).toContain('## 1. Deal Snapshot');
    expect(markdown).toContain('## 9. Confidence and Review Warnings');
    expect(markdown).toContain(`[^${ids.crmCitation}]`);
    expect(markdown).toContain(`[^${ids.restrictedCitation}]:`);
  });

  it('rejects conflicting citation labels identically in JSON and Markdown', () => {
    const conflicting = structuredClone(brief);
    const original = conflicting.executiveSummary.claims[0]!;
    conflicting.executiveSummary.claims = [{
      ...original,
      citations: original.citations.map((citation, index) => index === 0
        ? { ...citation, locator: 'salesforce/opportunities.tsv#conflicting-renewal' }
        : citation)
    }];

    expect(() => exportBrief(conflicting, 'markdown')).toThrow('conflicting immutable evidence');
    expect(() => exportBrief(conflicting, 'json')).toThrow('conflicting immutable evidence');
  });

  it('downloads authorized JSON and Markdown with safe private headers and records a redacted audit', async () => {
    const reader = await authenticate(app, ids.reader);
    const json = await reader.get(`/api/runs/${ids.run}/export/json`).set(browserHeaders).expect(200);
    expect(JSON.parse(json.text)).toEqual(brief);
    expect(json.headers['content-type']).toMatch(/^application\/json; charset=utf-8$/);
    expect(json.headers['content-disposition']).toBe(`attachment; filename="deal-brief-${ids.run}.json"`);
    expect(json.headers['cache-control']).toBe('private, no-store');

    const first = await reader.get(`/api/runs/${ids.run}/export/markdown`).set(browserHeaders).expect(200);
    const second = await reader.get(`/api/runs/${ids.run}/export/markdown`).set(browserHeaders).expect(200);
    expect(first.text).toBe(second.text);
    expect(first.text.match(/^## \d+\. /gm)).toHaveLength(9);
    expect(first.text).toContain(`[^${ids.crmCitation}]`);
    expect(first.text).toContain(`[^${ids.restrictedCitation}]:`);
    expect(first.headers['content-type']).toMatch(/^text\/markdown; charset=utf-8$/);
    expect(first.headers['content-disposition']).toBe(`attachment; filename="deal-brief-${ids.run}.md"`);
    expect(first.headers['cache-control']).toBe('private, no-store');

    const serialized = `${json.text}\n${first.text}\n${second.text}`;
    expect(serialized).not.toMatch(/RAW_(?:CRM|GONG)_(?:SOURCE|EVIDENCE)_SENTINEL/);
    const audits = await sql<{ type: string; run_id: string | null; actor_id: string | null; payload: unknown }[]>`
      select type, run_id, actor_id, payload from audit_events where run_id = ${ids.run} and type = 'brief_exported' order by created_at`;
    expect(audits).toHaveLength(3);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ run_id: ids.run, actor_id: ids.reader, payload: { format: 'json', status: 'completed' } }),
      expect.objectContaining({ run_id: ids.run, actor_id: ids.reader, payload: { format: 'markdown', status: 'completed' } })
    ]));
    expect(JSON.stringify(audits)).not.toMatch(/RAW_|Authorization|Cookie|prompt|completion/i);
  });

  it('rejects filename and header injection input before constructing download headers', async () => {
    const reader = await authenticate(app, ids.reader);
    const response = await reader
      .get('/api/runs/run_safe%0D%0AX-Injected%3Ayes/export/json')
      .set(browserHeaders)
      .expect(400);
    expect(response.headers['x-injected']).toBeUndefined();
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('makes unauthorized, missing, citation-denied, and authority-only exports identically opaque', async () => {
    const outsider = await authenticate(app, ids.outsider);
    const partial = await authenticate(app, ids.citationDenied);
    const authority = await authenticate(app, ids.authorityOnly);
    const reader = await authenticate(app, ids.reader);
    const unbound = await reader.get(`/api/runs/${ids.unboundRun}/export/json`).set(browserHeaders);
    const authorityOnly = await authority.get(`/api/runs/${ids.authorityRun}/export/json`).set(browserHeaders);
    const responses = [
      await outsider.get(`/api/runs/${ids.run}/export/json`).set(browserHeaders).expect(404),
      await partial.get(`/api/runs/${ids.run}/export/json`).set(browserHeaders).expect(404),
      await authority.get(`/api/runs/${ids.run}/export/json`).set(browserHeaders).expect(404),
      await outsider.get('/api/runs/run_missing_task14/export/json').set(browserHeaders).expect(404),
      unbound,
      authorityOnly
    ];
    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(responses.map(({ body }) => body)).toEqual(Array.from({ length: 6 }, () => ({
      code: 'NOT_FOUND', message: 'The requested resource was not found.'
    })));
    for (const response of responses) {
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toMatch(/citation|evidence|permission|authority|brief/i);
    }
    const successAuditsForDeniedActors = await sql<{ count: number }[]>`select count(*)::integer count from audit_events
      where type = 'brief_exported' and actor_id <> ${ids.reader}`;
    expect(successAuditsForDeniedActors[0]?.count).toBe(0);
    const durableDenials = await sql<{ run_id: string | null; payload: unknown }[]>`select run_id, payload from audit_events
      where type = 'brief_export_denied' order by created_at, id`;
    expect(durableDenials).toHaveLength(6);
    expect(durableDenials).toEqual(Array.from({ length: 6 }, () => ({
      run_id: null, payload: { reason: 'not_found' }
    })));
  });
});
