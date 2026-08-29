import type { NestExpressApplication } from '@nestjs/platform-express';
import { CANONICAL_FIXTURE_COMMIT } from '@slacato/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import postgres, { type Sql } from 'postgres';
import { createApiApplication } from '../../apps/api/src/main';

const origin = 'http://127.0.0.1:4173';
const browserHeaders = { Origin: origin, 'Sec-Fetch-Site': 'same-site' };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTime = z.iso.datetime({ offset: true });
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const sectionIds = [
  'dealSnapshot',
  'executiveSummary',
  'buyerGoalsAndBusinessDrivers',
  'stakeholderMap',
  'negotiationState',
  'recommendedNextActions',
  'missingInformation',
  'sourceEvidence',
  'confidenceAndReviewWarnings'
] as const;

async function authenticate(app: NestExpressApplication, userId: string) {
  const agent = request.agent(app.getHttpServer());
  const bootstrap = await agent.get('/api/auth/csrf').set(browserHeaders).expect(200);
  await agent.post('/api/auth/persona').set(browserHeaders)
    .set('X-CSRF-Token', bootstrap.body.csrfToken as string).send({ userId }).expect(201);
  return agent;
}

describe('authorized deal API projection', () => {
  let app: NestExpressApplication;
  let seedDatabase: Sql;

  beforeAll(async () => {
    seedDatabase = postgres(databaseUrl, { max: 1 });
    await seedDatabase`insert into personas (id, display_name, role, source_commit) values
      ('USR-91201', 'Gong Only', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT}),
      ('USR-91202', 'Mixed Restricted', 'Restricted Account Owner', ${CANONICAL_FIXTURE_COMMIT})`;
    await seedDatabase`insert into permission_grants
      (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing, source_commit)
      values
      ('grant:USR-91201:ACC-2001:gong_summary', 'USR-91201', 'ACC-2001', 'gong_summary', true, false, false, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      ('grant:USR-91202:ACC-2003:salesforce', 'USR-91202', 'ACC-2003', 'salesforce', true, true, false, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      ('grant:USR-91202:ACC-2003:slack', 'USR-91202', 'ACC-2003', 'slack', true, false, false, false, false, ${CANONICAL_FIXTURE_COMMIT})`;
    app = await createApiApplication({ environment: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: 'task-12-integration-session-secret-long-enough',
      AI_PROVIDER: 'mock',
      WEB_ORIGIN: origin
    } });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await seedDatabase`delete from permission_grants where persona_id in ('USR-91201', 'USR-91202')`;
    await seedDatabase`delete from personas where id in ('USR-91201', 'USR-91202')`;
    await seedDatabase.end({ timeout: 1 });
  });

  it('lists only deals authorized at the query boundary with strict ISO response values', async () => {
    const maya = await authenticate(app, 'USR-5001');
    const response = await maya.get('/api/deals').set(browserHeaders).expect(200);

    const parsed = z.object({
      sessionVersion: z.string().min(1),
      deals: z.array(z.object({
        opportunityId: z.string(), opportunityName: z.string(), accountName: z.string(), stage: z.string(),
        owner: z.string().nullable(), closeDate: isoDate.nullable(), amount: z.number().nullable(),
        currency: z.string().length(3).nullable(), probability: z.number().nullable(),
        riskLevel: z.enum(['low', 'medium', 'high', 'unknown']), restricted: z.boolean(),
        createdAt: isoDateTime,
        latestRun: z.object({ status: z.string(), updatedAt: isoDateTime }).nullable()
      }).strict())
    }).strict().parse(response.body);

    expect(parsed.deals.map((deal) => deal.opportunityId)).toEqual(['OPP-1001']);
    expect(JSON.stringify(parsed)).not.toContain('OPP-1003');
  });

  it('projects a complete source-backed workspace with stable citation and secondary chunk IDs', async () => {
    const maya = await authenticate(app, 'USR-5001');
    const response = await maya.get('/api/deals/OPP-1001').set(browserHeaders).expect(200);

    const body = response.body as Record<string, unknown>;
    expect(z.string().min(1).parse(body.sessionVersion)).toBeTruthy();
    expect(z.object({
      opportunityId: z.literal('OPP-1001'), opportunityName: z.string(), accountName: z.string(),
      stage: z.string(), closeDate: isoDate.nullable(), amount: z.number().nullable(),
      currency: z.string().length(3).nullable(), owner: z.string().nullable(), probability: z.number().nullable(),
      riskLevel: z.enum(['low', 'medium', 'high', 'unknown']), restricted: z.boolean(),
      createdAt: isoDateTime, latestRun: z.object({ status: z.string(), updatedAt: isoDateTime }).nullable()
    }).strict().parse(body.deal)).toBeTruthy();

    const brief = z.object({
      status: z.enum(['source_backed', 'generated']),
      overallConfidence: z.number().min(0).max(1),
      sections: z.record(z.string(), z.object({
        title: z.string(), paragraphs: z.array(z.string()), items: z.array(z.string()),
        citationIds: z.array(z.string()), accountTeamUpdateImpact: z.boolean()
      }).strict()),
      stakeholders: z.array(z.object({
        name: z.string(), title: z.string().nullable(), role: z.string(), influence: z.string(),
        relationship: z.string(), goals: z.array(z.string()), concerns: z.array(z.string()), citationIds: z.array(z.string())
      }).strict()),
      actions: z.array(z.object({ action: z.string(), owner: z.string().nullable(), priority: z.string(), dueDate: isoDate.nullable(), rationale: z.string(), citationIds: z.array(z.string()), accountTeamUpdateImpact: z.boolean() }).strict()),
      warnings: z.array(z.object({ severity: z.string(), message: z.string(), citationIds: z.array(z.string()), accountTeamUpdateImpact: z.boolean() }).strict())
    }).strict().parse(body.brief);
    expect(Object.keys(brief.sections)).toEqual(sectionIds);
    expect(brief.sections.missingInformation.accountTeamUpdateImpact).toBe(true);

    const evidence = z.array(z.object({
      id: z.string(), sourceType: z.string(), sourcePath: z.string(), stableKey: z.string(), stableId: z.string(),
      citationLabel: z.string(), chunkId: z.string(), capturedAt: isoDateTime, content: z.string()
    }).strict()).parse(body.evidence);
    const slack = evidence.find((item) => item.stableId === 'SLK-1001-02');
    expect(slack).toMatchObject({
      sourcePath: 'slack/account_team_updates.tsv', stableKey: 'update_id',
      citationLabel: 'source=slack/account_team_updates.tsv, update_id=SLK-1001-02',
      chunkId: 'slack:SLK-1001-02:0'
    });
  });

  it('filters unauthorized source types and denies hidden opportunities with one opaque response', async () => {
    const harper = await authenticate(app, 'USR-5007');
    const allowed = await harper.get('/api/deals/OPP-1001').set(browserHeaders).expect(200);
    const allowedText = JSON.stringify(allowed.body);
    expect(allowedText).not.toContain('\"sourceType\":\"slack\"');
    expect(allowedText).not.toContain('\"sourceType\":\"pricing\"');
    expect(allowedText).not.toContain('pricing_notes.tsv');
    expect(allowedText).not.toContain('account_team_updates.tsv');

    for (const opportunityId of ['OPP-1003', 'OPP-does-not-exist']) {
      const denied = await harper.get(`/api/deals/${opportunityId}`).set(browserHeaders).expect(403);
      expect(denied.body).toEqual({ code: 'FORBIDDEN', message: 'Request could not be authorized' });
      expect(JSON.stringify(denied.body)).not.toContain(opportunityId);
    }
  });

  it('does not project Salesforce list fields or non-restricted source grants across authorization scopes', async () => {
    const gongOnly = await authenticate(app, 'USR-91201');
    const list = await gongOnly.get('/api/deals').set(browserHeaders).expect(200);
    expect(list.body.deals).toEqual([expect.objectContaining({
      opportunityId: 'OPP-1001', stage: 'Stage unavailable', owner: null,
      closeDate: null, amount: null, probability: null, riskLevel: 'unknown'
    })]);

    const mixed = await authenticate(app, 'USR-91202');
    const workspace = await mixed.get('/api/deals/OPP-1003').set(browserHeaders).expect(200);
    expect(workspace.body.evidence).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'slack' })
    ]));
    expect(JSON.stringify(workspace.body)).not.toContain('account_team_updates.tsv');
  });
});
