import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentEvidenceRecord,
  EmbeddingProfile,
  ProviderAttemptLedger,
  RetrievedEvidence
} from '@slacato/core';
import { pruneAgentEvidence } from '../../packages/core/src/application/briefs/prompts.js';
import {
  createDatabaseClient,
  createMockModelGateways,
  EmbeddingIndexer,
  PostgresHybridEvidenceRetriever
} from '@slacato/infrastructure';
import { ingestFixtureRecords } from '../../scripts/ingest.js';

/**
 * Source coverage on the path a run actually takes.
 *
 * The finalized normal sample cites only Salesforce and one policy file, while the guided tour
 * promises the reviewer that Slack account-team updates appear in Source Evidence. This test asks
 * where that content is lost: it runs the query the deal-brief workflow issues, against a database
 * built from the canonical fixtures, and then applies the same context pruning the strategy agent
 * applies before the model ever sees the manifest. A failure here places the loss in retrieval or
 * context selection; a pass places it downstream, in generation or validation.
 *
 * The database is created and dropped per run, following `scripts/evaluate.ts`, so this never
 * writes into a database an end-to-end run later probes for readiness.
 */

const STRATEGY_SOURCES = new Set<AgentEvidenceRecord['sourceType']>([
  'gong_summary',
  'gong_transcript',
  'policy',
  'pricing',
  'salesforce',
  'slack'
]);

const baseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databaseName = `slacato_briefsrc_${randomUUID().replaceAll('-', '')}`;
const isolatedUrl = new URL(baseUrl);
isolatedUrl.pathname = `/${databaseName}`;

const unusedGenerationLedger: ProviderAttemptLedger = {
  async beginAttempt() {
    throw new Error('Generation is unavailable during deterministic source-coverage evaluation');
  },
  async settleAttempt() {},
  async releaseAttempt() {}
};

let admin: ReturnType<typeof postgres> | undefined;
let database: ReturnType<typeof createDatabaseClient> | undefined;
let retrieved: readonly RetrievedEvidence[] = [];

beforeAll(async () => {
  admin = postgres(baseUrl, { max: 1 });
  await admin.unsafe(`create database "${databaseName}"`);
  database = createDatabaseClient(isolatedUrl.toString(), 4);
  await migrate(drizzle(database.sql), { migrationsFolder: resolve('drizzle') });
  await ingestFixtureRecords({
    root: resolve('fixtures/cato'),
    databaseUrl: isolatedUrl.toString()
  });
  const mock = createMockModelGateways({
    resolve: () => ({ text: '{}' }),
    attemptLedger: unusedGenerationLedger
  });
  const profile: EmbeddingProfile = {
    provider: mock.embeddingProfile.providerId,
    model: mock.embeddingProfile.modelId,
    dimension: mock.embeddingProfile.dimension,
    profile: 'mock-token-hash-64',
    version: 'v1',
    normalization: 'l2'
  };
  await new EmbeddingIndexer(database, mock.embeddingGateway, profile).index();
  const retriever = new PostgresHybridEvidenceRetriever(
    database,
    mock.embeddingGateway,
    profile,
    () => new Date('2026-08-28T00:00:00.000Z')
  );
  const runId = `run_brief_source_${databaseName}`;
  await database.sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash)
    values (${runId}, 'OPP-1001', 'USR-5001', 'retrieving', 'mock', 'mock-brief', ${`source-coverage:${runId}`})`;
  // The query and limits the deal-brief workflow issues for a run; see
  // packages/infrastructure/src/worker/postgres-deal-brief-workflow-services.ts.
  const result = await retriever.search({
    query: 'Northstar Foods Cooperative - Global Access Renewal negotiation commercial terms stakeholders',
    accountId: 'ACC-2001',
    opportunityId: 'OPP-1001',
    runId,
    limit: 20,
    maxContextCharacters: 60_000,
    scope: {
      personaId: 'USR-5001',
      allowed: true,
      accountIds: ['ACC-2001'],
      sourceTypes: ['gong_summary', 'gong_transcript', 'policy', 'pricing', 'salesforce', 'slack'],
      canViewSensitivePricing: false,
      canRequestApproval: true,
      canApprove: false,
      canViewRestrictedAccounts: false
    }
  });
  await database.sql`update runs set status = 'completed' where id = ${runId}`;
  retrieved = result.evidence;
}, 180_000);

afterAll(async () => {
  await database?.close();
  await admin?.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await admin?.end({ timeout: 1 });
});

describe('brief source coverage', () => {
  it('retrieves more than one source family for the authorized happy-path deal', () => {
    expect([...new Set(retrieved.map((record) => record.sourceType))].sort().length).toBeGreaterThan(
      1
    );
  });

  it('retrieves the Slack account-team updates the guided tour promises the reviewer', () => {
    expect(retrieved.map((record) => record.sourceType)).toContain('slack');
  });

  it('retrieves Gong conversation evidence for the deal', () => {
    expect(
      retrieved.some(
        (record) =>
          record.sourceType === 'gong_summary' || record.sourceType === 'gong_transcript'
      )
    ).toBe(true);
  });

  it('keeps Slack and Gong evidence in the context the strategy agent is given', () => {
    const records = retrieved.map((record) => ({
      ...record,
      accountId: 'ACC-2001',
      opportunityId: 'OPP-1001'
    })) as readonly AgentEvidenceRecord[];
    const pruned = pruneAgentEvidence(records, STRATEGY_SOURCES);
    const sourceTypes = new Set(pruned.map((record) => record.sourceType));
    expect([...sourceTypes].sort()).toEqual(
      expect.arrayContaining(['salesforce', 'slack'])
    );
    expect(
      pruned.some(
        (record) =>
          record.sourceType === 'gong_summary' || record.sourceType === 'gong_transcript'
      )
    ).toBe(true);
  });
});
