import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CANONICAL_FIXTURE_COMMIT, dealBriefSchema } from '@slacato/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApiApplication } from '../../apps/api/src/main';
import { ingestFixtureRecords } from '../../scripts/ingest';

const origin = 'http://127.0.0.1:4173';
const browserHeaders = { Origin: origin, 'Sec-Fetch-Site': 'same-site' };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTime = z.iso.datetime({ offset: true });
const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databaseName = `catohw_deals_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const databaseNamePattern = /^catohw_deals_[a-z0-9]{16}$/;
function databaseUrlFor(name: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
const databaseUrl = databaseUrlFor(databaseName);
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
const workspaceDraftRunId = `deal-workspace-draft-${process.pid}`;
const workspaceDraftSubjectId = `deal-workspace-draft-subject-${process.pid}`;
const workspaceSupersededSubjectId = `deal-workspace-superseded-subject-${process.pid}`;
const workspaceFinalizedRunId = `deal-workspace-finalized-${process.pid}`;
const workspaceFinalizedBriefId = `deal-workspace-finalized-brief-${process.pid}`;
const workspaceFinalizedSubjectId = `deal-workspace-finalized-subject-${process.pid}`;
const generatedDraft = dealBriefSchema.parse({
  dealSnapshot: {
    accountName: 'Northstar Foods Cooperative',
    opportunityName: 'Global Access Renewal',
    stage: 'Order Review'
  },
  executiveSummary: { narrative: 'A generated draft is ready for seller review.' },
  buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
  stakeholderMap: { stakeholders: [] },
  negotiationState: { currentState: 'The negotiation remains active.', risks: [] },
  recommendedNextActions: { actions: [] },
  missingInformation: { items: [] },
  sourceEvidence: {
    evidence: [
      {
        evidenceId: 'slack:SLK-9002:0',
        sourceType: 'conversation',
        summary: 'Private Slack summary.',
        capturedAt: '2026-04-22T00:00:00.000Z',
        claims: []
      }
    ]
  },
  confidenceAndReviewWarnings: { overallConfidence: 0.5, warnings: [] }
});

async function authenticate(app: NestExpressApplication, userId: string) {
  const agent = request.agent(app.getHttpServer());
  const bootstrap = await agent.get('/api/auth/csrf').set(browserHeaders).expect(200);
  await agent
    .post('/api/auth/persona')
    .set(browserHeaders)
    .set('X-CSRF-Token', bootstrap.body.csrfToken as string)
    .send({ userId })
    .expect(201);
  return agent;
}

describe('authorized deal API projection', () => {
  let app: NestExpressApplication;
  let seedDatabase: Sql;
  let admin: Sql;

  beforeAll(async () => {
    if (!databaseNamePattern.test(databaseName))
      throw new Error(`Refusing to create non-test database ${databaseName}`);
    admin = postgres(databaseUrlFor('postgres'), { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    seedDatabase = postgres(databaseUrl, { max: 1 });
    await migrate(drizzle(seedDatabase), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    await ingestFixtureRecords({ root: 'fixtures/cato', databaseUrl });
    await seedDatabase`insert into personas (id, display_name, role, source_commit) values
      ('USR-91201', 'Gong Only', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT}),
      ('USR-91202', 'Mixed Restricted', 'Restricted Account Owner', ${CANONICAL_FIXTURE_COMMIT}),
      ('USR-91203', 'Mixed Standard', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT})`;
    await seedDatabase`insert into permission_grants
      (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing, source_commit)
      values
      ('grant:USR-91201:ACC-2001:gong_summary', 'USR-91201', 'ACC-2001', 'gong_summary', true, false, false, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      ('stale:USR-91201:ACC-2001:salesforce', 'USR-91201', 'ACC-2001', 'salesforce', true, true, false, false, false, null),
      ('stale:USR-91201:ACC-2001:slack', 'USR-91201', 'ACC-2001', 'slack', true, true, false, false, false, ${'0'.repeat(40)}),
      ('stale:USR-91201:ACC-2001:pricing', 'USR-91201', 'ACC-2001', 'pricing', true, true, false, false, true, ${'0'.repeat(40)}),
      ('grant:USR-91202:ACC-2003:salesforce', 'USR-91202', 'ACC-2003', 'salesforce', true, true, false, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      ('grant:USR-91202:ACC-2003:slack', 'USR-91202', 'ACC-2003', 'slack', true, false, false, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      ('grant:USR-91203:ACC-2001:salesforce', 'USR-91203', 'ACC-2001', 'salesforce', true, true, false, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      ('grant:USR-91203:ACC-2001:slack', 'USR-91203', 'ACC-2001', 'slack', true, false, false, false, false, ${CANONICAL_FIXTURE_COMMIT})`;
    app = await createApiApplication({
      environment: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 'task-12-integration-session-secret-long-enough',
        AI_PROVIDER: 'mock',
        WEB_ORIGIN: origin
      }
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await seedDatabase?.end({ timeout: 1 });
    if (admin !== undefined) {
      if (!databaseNamePattern.test(databaseName))
        throw new Error(`Refusing to drop non-test database ${databaseName}`);
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 1 });
    }
  });

  it('lists only deals authorized at the query boundary with strict ISO response values', async () => {
    const maya = await authenticate(app, 'USR-5001');
    const response = await maya.get('/api/deals').set(browserHeaders).expect(200);

    const parsed = z
      .object({
        sessionVersion: z.string().min(1),
        deals: z.array(
          z
            .object({
              opportunityId: z.string(),
              opportunityName: z.string(),
              accountName: z.string(),
              stage: z.string(),
              owner: z.string().nullable(),
              closeDate: isoDate.nullable(),
              amount: z.number().nullable(),
              currency: z.string().length(3).nullable(),
              probability: z.number().nullable(),
              riskLevel: z.enum(['low', 'medium', 'high', 'unknown']),
              restricted: z.boolean(),
              createdAt: isoDateTime,
              latestRun: z.object({ status: z.string(), updatedAt: isoDateTime }).nullable()
            })
            .strict()
        )
      })
      .strict()
      .parse(response.body);

    expect(parsed.deals.map((deal) => deal.opportunityId)).toEqual(['OPP-1001']);
    expect(JSON.stringify(parsed)).not.toContain('OPP-1003');
  });

  it('projects a complete source-backed workspace with stable citation and secondary chunk IDs', async () => {
    const maya = await authenticate(app, 'USR-5001');
    const response = await maya.get('/api/deals/OPP-1001').set(browserHeaders).expect(200);

    const body = response.body as Record<string, unknown>;
    expect(z.string().min(1).parse(body.sessionVersion)).toBeTruthy();
    expect(
      z
        .object({
          opportunityId: z.literal('OPP-1001'),
          opportunityName: z.string(),
          accountName: z.string(),
          stage: z.string(),
          closeDate: isoDate.nullable(),
          amount: z.number().nullable(),
          currency: z.string().length(3).nullable(),
          owner: z.string().nullable(),
          probability: z.number().nullable(),
          riskLevel: z.enum(['low', 'medium', 'high', 'unknown']),
          restricted: z.boolean(),
          createdAt: isoDateTime,
          latestRun: z.object({ status: z.string(), updatedAt: isoDateTime }).nullable()
        })
        .strict()
        .parse(body.deal)
    ).toBeTruthy();

    const brief = z
      .object({
        status: z.enum(['source_backed', 'generated']),
        overallConfidence: z.number().min(0).max(1),
        sections: z.record(
          z.string(),
          z
            .object({
              title: z.string(),
              paragraphs: z.array(z.string()),
              items: z.array(z.string()),
              citationIds: z.array(z.string()),
              accountTeamUpdateImpact: z.boolean()
            })
            .strict()
        ),
        stakeholders: z.array(
          z
            .object({
              name: z.string(),
              title: z.string().nullable(),
              role: z.string(),
              influence: z.string(),
              relationship: z.string(),
              goals: z.array(z.string()),
              concerns: z.array(z.string()),
              citationIds: z.array(z.string())
            })
            .strict()
        ),
        actions: z.array(
          z
            .object({
              action: z.string(),
              audience: z.enum(['internal', 'customer']),
              owner: z.string().nullable(),
              priority: z.string(),
              dueDate: isoDate.nullable(),
              rationale: z.string(),
              citationIds: z.array(z.string()),
              accountTeamUpdateImpact: z.boolean()
            })
            .strict()
        ),
        warnings: z.array(
          z
            .object({
              severity: z.string(),
              message: z.string(),
              citationIds: z.array(z.string()),
              accountTeamUpdateImpact: z.boolean()
            })
            .strict()
        )
      })
      .strict()
      .parse(body.brief);
    expect(Object.keys(brief.sections)).toEqual(sectionIds);
    expect(brief.sections.missingInformation.accountTeamUpdateImpact).toBe(true);

    const evidence = z
      .array(
        z
          .object({
            id: z.string(),
            sourceType: z.string(),
            sourcePath: z.string(),
            stableKey: z.string(),
            stableId: z.string(),
            citationLabel: z.string(),
            chunkId: z.string(),
            capturedAt: isoDateTime,
            content: z.string()
          })
          .strict()
      )
      .parse(body.evidence);
    const slack = evidence.find((item) => item.sourceType === 'slack');
    if (slack === undefined) throw new Error('Authorized Slack evidence is unavailable');
    expect(slack).toMatchObject({
      sourcePath: 'synthetic_data/slack/account_team_updates.tsv',
      stableKey: 'update_id'
    });
    expect(slack.citationLabel).toBe(
      `source=synthetic_data/slack/account_team_updates.tsv, update_id=${slack.stableId}`
    );
    expect(slack.chunkId).toBe(`slack:${slack.stableId}:0`);
  });

  it('filters unauthorized source types and denies hidden opportunities with one opaque response', async () => {
    const harper = await authenticate(app, 'USR-5007');
    const allowed = await harper.get('/api/deals/OPP-1001').set(browserHeaders).expect(200);
    const allowedText = JSON.stringify(allowed.body);
    expect(allowedText).not.toContain('"sourceType":"slack"');
    expect(allowedText).not.toContain('"sourceType":"pricing"');
    expect(allowedText).not.toContain('pricing_notes.tsv');
    expect(allowedText).not.toContain('account_team_updates.tsv');

    const auditedBefore = await seedDatabase<{ count: number }[]>`
      select count(*)::int count from audit_events where actor_id = 'USR-5007'`;

    for (const opportunityId of ['OPP-1003', 'OPP-does-not-exist']) {
      const denied = await harper
        .get(`/api/deals/${opportunityId}`)
        .set(browserHeaders)
        .expect(403);
      expect(denied.body).toEqual({
        code: 'FORBIDDEN',
        message: 'Request could not be authorized'
      });
      expect(JSON.stringify(denied.body)).not.toContain(opportunityId);
    }

    // The tour tells a reviewer the denial is audited. It is - and the record proves the refusal
    // happened without describing what was refused, so a restricted deal and a deal that does not
    // exist leave rows nothing can tell apart.
    const denialAudit = await seedDatabase<
      {
        run_id: string | null;
        actor_id: string;
        type: string;
        payload: unknown;
      }[]
    >`select run_id, actor_id, type, payload from audit_events
      where actor_id = 'USR-5007' order by created_at`;
    expect(denialAudit).toHaveLength((auditedBefore[0]?.count ?? 0) + 2);
    const denialRow = {
      run_id: null,
      actor_id: 'USR-5007',
      type: 'deal_brief_access_denied',
      payload: { reason: 'forbidden' }
    };
    expect(denialAudit.slice(-2)).toEqual([denialRow, denialRow]);
    expect(JSON.stringify(denialAudit.slice(-2))).not.toMatch(
      /OPP-1003|OPP-does-not-exist|ACC-2003|Northstar|restricted|evidence|slack|pricing/i
    );

    // A denial audit is only non-disclosing while nothing can read it back. No API surfaces
    // audit_events at all, so the persona it refused cannot reach its own denial record.
    const auditReadPaths = await seedDatabase<{ count: number }[]>`
      select count(*)::int count from information_schema.view_table_usage
      where table_name = 'audit_events'`;
    expect(auditReadPaths[0]?.count).toBe(0);
  });

  it('does not project Salesforce list fields or non-restricted source grants across authorization scopes', async () => {
    const gongOnly = await authenticate(app, 'USR-91201');
    const list = await gongOnly.get('/api/deals').set(browserHeaders).expect(200);
    expect(list.body.deals).toEqual([
      expect.objectContaining({
        opportunityId: 'OPP-1001',
        opportunityName: 'OPP-1001',
        accountName: 'ACC-2001',
        stage: 'Stage unavailable',
        owner: null,
        closeDate: null,
        amount: null,
        probability: null,
        riskLevel: 'unknown'
      })
    ]);
    expect(JSON.stringify(list.body)).not.toMatch(
      /Global Access Renewal|Northstar Foods Cooperative|gong_summary|stale:/
    );
    const staleWorkspace = await gongOnly
      .get('/api/deals/OPP-1001')
      .set(browserHeaders)
      .expect(200);
    expect(
      staleWorkspace.body.evidence.every(
        (item: { sourceType: string }) => item.sourceType === 'gong_summary'
      )
    ).toBe(true);
    expect(JSON.stringify(staleWorkspace.body)).not.toMatch(
      /account_team_updates|pricing_notes|salesforce\/opportunities/
    );

    await seedDatabase`insert into document_versions
      (id, external_id, version, source_type, content_hash, content)
      values ('task12-doc-standard-slack-restricted-deal', 'task12-doc-standard-slack-restricted-deal', 1, 'slack',
        'task12-doc-standard-slack-restricted-deal', 'standard Slack on restricted deal')
      on conflict do nothing`;
    await seedDatabase`insert into evidence_versions
      (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content,
        source_locator, reliability_class, classification_reason, policy_hash)
      values ('task12:standard-slack-restricted-deal:0', 'task12-doc-standard-slack-restricted-deal', 'ACC-2003', 'OPP-1003', 0,
        'slack', 'standard', 'task12-standard-slack-restricted-deal',
        'updateId: SLK-TASK12-STANDARD-RESTRICTED-DEAL\nupdateText: PRIVATE STANDARD SLACK ON RESTRICTED DEAL',
        'slack/account_team_updates.tsv#SLK-TASK12-STANDARD-RESTRICTED-DEAL#chunk-0', 'direct_conversation',
        'task12_test', ${'c'.repeat(64)})
      on conflict do nothing`;
    const mixed = await authenticate(app, 'USR-91202');
    const workspace = await mixed.get('/api/deals/OPP-1003').set(browserHeaders).expect(200);
    expect(workspace.body.evidence).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceType: 'slack' })])
    );
    expect(JSON.stringify(workspace.body)).not.toContain('account_team_updates.tsv');
    expect(JSON.stringify(workspace.body)).not.toContain(
      'PRIVATE STANDARD SLACK ON RESTRICTED DEAL'
    );
    expect(JSON.stringify(workspace.body)).not.toContain('SLK-TASK12-STANDARD-RESTRICTED-DEAL');
  });

  it('authorizes restricted evidence against the matching source grant and requires real provenance', async () => {
    await seedDatabase`insert into document_versions
      (id, external_id, version, source_type, content_hash, content)
      values
      ('task12-doc-restricted-slack', 'task12-doc-restricted-slack', 1, 'slack', 'task12-doc-restricted-slack', 'restricted Slack')
      on conflict do nothing`;
    await seedDatabase`insert into evidence_versions
      (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content,
        source_locator, reliability_class, classification_reason, policy_hash)
      values ('task12:restricted-slack:0', 'task12-doc-restricted-slack', 'ACC-2001', 'OPP-1001', 0, 'slack', 'restricted',
        'task12-restricted-slack', 'updateId: SLK-TASK12-RESTRICTED\nupdateText: PRIVATE RESTRICTED SLACK ROW',
        'slack/account_team_updates.tsv#SLK-TASK12-RESTRICTED#chunk-0', 'direct_conversation', 'task12_test', ${'a'.repeat(64)})
      on conflict do nothing`;
    const mixed = await authenticate(app, 'USR-91203');
    const workspace = await mixed.get('/api/deals/OPP-1001').set(browserHeaders).expect(200);
    expect(workspace.body.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: 'slack', stableId: expect.stringMatching(/^SLK-/) })
      ])
    );
    expect(JSON.stringify(workspace.body)).not.toContain('PRIVATE RESTRICTED SLACK ROW');

    await seedDatabase`insert into document_versions
      (id, external_id, version, source_type, content_hash, content)
      values
      ('task12-doc-null-provenance', 'task12-doc-null-provenance', 1, 'slack', 'task12-doc-null-provenance', 'legacy')
      on conflict do nothing`;
    await seedDatabase`insert into evidence_versions
      (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content)
      values ('slack:legacy-null-provenance:999', 'task12-doc-null-provenance', 'ACC-2001', 'OPP-1001', 0, 'slack', 'standard',
        'task12-null-provenance', 'PRIVATE LEGACY ROW WITHOUT PROVENANCE')
      on conflict do nothing`;
    const maya = await authenticate(app, 'USR-5001');
    const mayaWorkspace = await maya.get('/api/deals/OPP-1001').set(browserHeaders).expect(200);
    expect(JSON.stringify(mayaWorkspace.body)).not.toContain(
      'PRIVATE LEGACY ROW WITHOUT PROVENANCE'
    );
    expect(JSON.stringify(mayaWorkspace.body)).not.toContain('source/unavailable');
  });

  it('does not project restricted Salesforce evidence through a standard opportunity list', async () => {
    await seedDatabase`insert into document_versions
      (id, external_id, version, source_type, content_hash, content)
      values
      ('task12-doc-restricted-salesforce', 'task12-doc-restricted-salesforce', 1, 'salesforce', 'task12-doc-restricted-salesforce', 'restricted CRM')
      on conflict do nothing`;
    await seedDatabase`insert into evidence_versions
      (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content,
        source_locator, reliability_class, classification_reason, policy_hash)
      values ('000-task12-restricted-salesforce', 'task12-doc-restricted-salesforce', 'ACC-2001', 'OPP-1001', 0, 'salesforce', 'restricted',
        'task12-restricted-salesforce',
        'opportunityId: OPP-1001\nstage: SECRET STAGE\nowner: SECRET OWNER\ncloseDate: 2026-12-31\nacv: 999999\nprobability: 99\nriskLevel: high',
        'salesforce/opportunities.tsv#OPP-1001#task12-restricted', 'authoritative_system', 'task12_test', ${'b'.repeat(64)})
      on conflict do nothing`;
    const harper = await authenticate(app, 'USR-5007');
    const list = await harper.get('/api/deals').set(browserHeaders).expect(200);
    expect(list.body.deals).toEqual([
      expect.objectContaining({
        opportunityId: 'OPP-1001',
        stage: '6.0 Order Review',
        owner: 'Maya Levin',
        closeDate: '2026-05-17',
        amount: 4_217_500,
        probability: 78,
        riskLevel: 'medium'
      })
    ]);
    expect(JSON.stringify(list.body)).not.toContain('SECRET');
  });
  it('separates generated output and projects only the actor-authorized current approval subject', async () => {
    const maya = await authenticate(app, 'USR-5001');
    const beforeGeneration = await maya.get('/api/deals/OPP-1001').set(browserHeaders).expect(200);
    expect(beforeGeneration.body).toMatchObject({
      sourceSnapshot: {
        type: 'source_snapshot',
        label: 'Source snapshot',
        evidenceOverview: { status: 'source_backed' }
      },
      generatedOutput: null
    });

    await seedDatabase`insert into runs
      (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
      values (${workspaceDraftRunId}, 'OPP-1001', 'USR-5001', 'awaiting_approval', 'mock', 'draft-preview', ${'d'.repeat(64)}, 1)`;
    await seedDatabase`insert into approval_subjects
      (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
      values
      (${workspaceSupersededSubjectId}, ${workspaceDraftRunId}, 0, ${'c'.repeat(64)}, ${JSON.stringify(generatedDraft)}::jsonb,
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'deal-brief-approval-v1'),
      (${workspaceDraftSubjectId}, ${workspaceDraftRunId}, 1, ${'e'.repeat(64)}, ${JSON.stringify(generatedDraft)}::jsonb,
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'deal-brief-approval-v1')`;
    await seedDatabase`update approval_subjects
      set superseded_by_subject_id = ${workspaceDraftSubjectId}
      where id = ${workspaceSupersededSubjectId}`;
    await seedDatabase`insert into approval_requirement_entries
      (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
      values
      ('deal-workspace-superseded-entry', ${workspaceSupersededSubjectId}, 'customer_communication',
        '["account_owner"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0),
      ('deal-workspace-current-entry', ${workspaceDraftSubjectId}, 'customer_communication',
        '["account_owner"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0)`;

    const response = await maya.get('/api/deals/OPP-1001').set(browserHeaders).expect(200);
    expect(response.body).toMatchObject({
      sourceSnapshot: {
        type: 'source_snapshot',
        label: 'Source snapshot',
        evidenceOverview: { status: 'source_backed' }
      },
      generatedOutput: {
        type: 'generated_output',
        lifecycle: 'draft',
        producingRun: { id: workspaceDraftRunId, status: 'awaiting_approval' },
        approvalReview: { approvalSubjectId: workspaceDraftSubjectId },
        content: { status: 'generated' }
      },
      brief: { status: 'generated' }
    });
    expect(response.body.generatedOutput.producingRun.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.body.generatedOutput.approvalReview).toEqual({
      approvalSubjectId: workspaceDraftSubjectId
    });
    expect(JSON.stringify(response.body.generatedOutput.approvalReview)).not.toContain(
      workspaceSupersededSubjectId
    );

    const nonApprover = await authenticate(app, 'USR-91203');
    const nonApproverWorkspace = await nonApprover
      .get('/api/deals/OPP-1001')
      .set(browserHeaders)
      .expect(200);
    expect(nonApproverWorkspace.body.generatedOutput).toMatchObject({
      lifecycle: 'draft',
      approvalReview: null
    });
    expect(JSON.stringify(nonApproverWorkspace.body)).not.toContain(workspaceDraftSubjectId);
    expect(JSON.stringify(nonApproverWorkspace.body)).not.toContain(workspaceSupersededSubjectId);

    const partialReader = await authenticate(app, 'USR-5007');
    const partialWorkspace = await partialReader
      .get('/api/deals/OPP-1001')
      .set(browserHeaders)
      .expect(200);
    expect(partialWorkspace.body).toMatchObject({
      sourceSnapshot: {
        type: 'source_snapshot',
        evidenceOverview: { status: 'source_backed' }
      },
      generatedOutput: null,
      brief: { status: 'source_backed' }
    });
    expect(JSON.stringify(partialWorkspace.body)).not.toContain('Private Slack summary.');
    expect(JSON.stringify(partialWorkspace.body)).not.toContain(workspaceDraftSubjectId);

    await seedDatabase`insert into runs
      (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version, updated_at)
      values (${workspaceFinalizedRunId}, 'OPP-1001', 'USR-5001', 'completed', 'mock', 'finalized-preview',
        ${'f'.repeat(64)}, 2, now() + interval '1 minute')`;
    await seedDatabase`insert into approval_subjects
      (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
      values (${workspaceFinalizedSubjectId}, ${workspaceFinalizedRunId}, 0, ${'b'.repeat(64)},
        ${JSON.stringify(generatedDraft)}::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        '[]'::jsonb, 'deal-brief-approval-v1')`;
    await seedDatabase`insert into approval_requirement_entries
      (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
      values ('deal-workspace-finalized-entry', ${workspaceFinalizedSubjectId}, 'customer_communication',
        '["account_owner"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0)`;
    await seedDatabase`insert into briefs
      (id, run_id, approval_subject_id, draft_version, payload, subject_hash, finalized_at)
      values (${workspaceFinalizedBriefId}, ${workspaceFinalizedRunId}, ${workspaceFinalizedSubjectId}, 0,
        ${JSON.stringify(generatedDraft)}::jsonb, ${'b'.repeat(64)}, now())`;

    const finalizedWorkspace = await maya
      .get('/api/deals/OPP-1001')
      .set(browserHeaders)
      .expect(200);
    expect(finalizedWorkspace.body.generatedOutput).toMatchObject({
      lifecycle: 'finalized',
      producingRun: { id: workspaceFinalizedRunId, status: 'completed' },
      approvalReview: null
    });
    expect(JSON.stringify(finalizedWorkspace.body)).not.toContain(workspaceFinalizedSubjectId);
  });
});
