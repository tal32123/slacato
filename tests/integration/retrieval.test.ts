import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorizationDeniedError, buildEvidencePlan, type EmbeddingProfile } from '@slacato/core';
import {
  EmbeddingIndexer,
  PostgresCitationResolver,
  PostgresHybridEvidenceRetriever,
  createDatabaseClient,
  createMockModelGateways
} from '@slacato/infrastructure';

const adminUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databaseName = `slacato_retrieval_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
let database: ReturnType<typeof createDatabaseClient>;
let sql: ReturnType<typeof postgres>;

const attempts = {
  async beginAttempt(): Promise<never> { throw new Error('generation is not used while indexing'); },
  async completeAttempt(): Promise<void> {},
  async failAttempt(): Promise<void> {}
};
const mock = createMockModelGateways({ resolve: () => ({ text: '{}' }), attemptLedger: attempts as never });
const profile: EmbeddingProfile = {
  provider: mock.embeddingProfile.providerId,
  model: mock.embeddingProfile.modelId,
  dimension: mock.embeddingProfile.dimension,
  profile: 'mock-token-hash-64',
  version: 'v1',
  normalization: 'l2'
};
const seededFixtureCorpus = {
  sourceLocatorPrefixes: ['fixture#sf', 'fixture#policy', 'fixture#slack', 'fixture#pricing'],
  requireCompleteProvenance: true
} as const;

beforeAll(async () => {
  await admin.unsafe(`create database "${databaseName}"`);
  database = createDatabaseClient(databaseUrl.toString(), 3);
  await migrate(drizzle(database.sql), { migrationsFolder: resolve('drizzle') });
  sql = postgres(databaseUrl.toString(), { max: 2 });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await database?.close();
  await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await admin.end({ timeout: 1 });
});

async function seed(): Promise<Readonly<{ accountId: string; opportunityId: string; runId: string; userId: string; deniedUserId: string }>> {
  const suffix = randomUUID().replaceAll('-', '');
  const accountId = `account_retrieval_${suffix}`;
  const opportunityId = `opportunity_retrieval_${suffix}`;
  const runId = `run_retrieval_${suffix}`;
  const userId = `user_retrieval_${suffix}`;
  const deniedUserId = `user_retrieval_denied_${suffix}`;
  await sql`insert into accounts (id, name) values (${accountId}, 'Acme')`;
  await sql`insert into personas (id, display_name, role) values (${userId}, 'Authorized', 'Account Owner'), (${deniedUserId}, 'Denied', 'Account Owner')`;
  await sql`insert into opportunities (id, account_id, name, restricted) values (${opportunityId}, ${accountId}, 'Renewal', false)`;
  await sql`insert into permission_grants (id, persona_id, account_id, source_type, can_read, sensitive_pricing)
    values (${`grant_sf_${suffix}`}, ${userId}, ${accountId}, 'salesforce', true, false),
      (${`grant_policy_${suffix}`}, ${userId}, ${accountId}, 'policy', true, false),
      (${`grant_slack_${suffix}`}, ${userId}, ${accountId}, 'slack', true, false),
      (${`grant_pricing_${suffix}`}, ${userId}, ${accountId}, 'pricing', true, false)`;
  await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model)
    values (${runId}, ${opportunityId}, ${userId}, 'retrieving', 'mock', 'mock-brief')`;
  const records = [
    ['sf', 'salesforce', 'standard', 'non-standard termination clause requested by buyer', '2026-08-20', 'authoritative_system'],
    ['policy', 'policy', 'standard', 'termination clauses require legal approval', '2020-01-01', 'authoritative_policy'],
    ['slack', 'slack', 'standard', 'buyer asked for termination protection', '2026-08-26', 'internal_collaboration'],
    ['pricing', 'pricing', 'restricted', 'secret floor discount and termination package', '2026-08-27', 'authoritative_system']
  ] as const;
  for (const [key, sourceType, sensitivity, content, eventDate, reliability] of records) {
    const documentId = `document_${key}_${suffix}`;
    const evidenceId = `evidence_${key}_${suffix}`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
      values (${documentId}, ${documentId}, 1, ${sourceType}, ${`doc-hash-${key}`}, ${content}, ${eventDate}, ${reliability}, ${`fixture#${key}`}, 'test_classification', ${'a'.repeat(64)})`;
    await sql`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
      values (${evidenceId}, ${documentId}, ${accountId}, ${opportunityId}, 0, ${sourceType}, ${sensitivity}, ${`chunk-hash-${key}`}, ${content}, ${eventDate}, ${reliability}, ${`fixture#${key}:0`}, 'test_classification', ${'a'.repeat(64)})`;
  }
  return { accountId, opportunityId, runId, userId, deniedUserId };
}

describe('provider-neutral embedding indexing', () => {
  it('indexes in batches, validates the profile, and skips unchanged chunks on the second run', async () => {
    await seed();
    const indexer = new EmbeddingIndexer(database, mock.embeddingGateway, profile, { batchSize: 2 });
    const first = await indexer.index();
    const second = await indexer.index();
    expect(first.indexed).toBe(4);
    expect(first.batches).toBe(2);
    expect(second).toEqual({ indexed: 0, skipped: 4, batches: 0 });
  });

  it('refuses an index containing a mixed embedding profile', async () => {
    await seed();
    await expect(new EmbeddingIndexer(database, mock.embeddingGateway, { ...profile, model: 'other-model' }).index())
      .rejects.toThrow('mixed embedding profiles');
  });

  it('scopes mixed-profile checks to the configured canonical provenance corpus', async () => {
    const seeded = await seed();
    const suffix = randomUUID().replaceAll('-', '');
    const unrelatedDocument = `document_unrelated_${suffix}`;
    const canonicalDocument = `document_canonical_${suffix}`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash) values
      (${unrelatedDocument}, ${unrelatedDocument}, 1, 'salesforce', 'unrelated-document-hash', 'unrelated', '2026-08-01', 'authoritative_system', 'fixture#unrelated', 'test', ${'a'.repeat(64)}),
      (${canonicalDocument}, ${canonicalDocument}, 1, 'salesforce', 'canonical-document-hash', 'canonical opportunity', '2026-08-01', 'authoritative_system', 'salesforce/opportunities.tsv#canonical', 'canonical_rule', ${'b'.repeat(64)})`;
    await sql`insert into evidence_versions
      (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash, embedding, embedding_provider, embedding_model, embedding_dimension, embedding_profile, embedding_version, embedding_normalization)
      values (${`evidence_unrelated_${suffix}`}, ${unrelatedDocument}, ${seeded.accountId}, ${seeded.opportunityId}, 0, 'salesforce', 'standard', 'unrelated-hash', 'unrelated', '2026-08-01', 'authoritative_system', 'fixture#unrelated:0', 'test', ${'a'.repeat(64)}, '[1,0]'::vector, 'other', 'other', 2, 'other', 'v9', 'l2')`;
    await sql`insert into evidence_versions
      (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
      values (${`evidence_canonical_${suffix}`}, ${canonicalDocument}, ${seeded.accountId}, ${seeded.opportunityId}, 0, 'salesforce', 'standard', 'canonical-hash', 'canonical opportunity', '2026-08-01', 'authoritative_system', 'salesforce/opportunities.tsv#canonical:0', 'canonical_rule', ${'b'.repeat(64)})`;
    const corpus = { sourceLocatorPrefixes: ['salesforce/', 'gong/', 'pricing/', 'slack/', 'policies/'], requireCompleteProvenance: true } as const;
    await expect(new EmbeddingIndexer(database, mock.embeddingGateway, profile, { corpus }).index()).resolves.toEqual({ indexed: 1, skipped: 0, batches: 1 });
    const canonicalMixedDocument = `document_canonical_mixed_${suffix}`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
      values (${canonicalMixedDocument}, ${canonicalMixedDocument}, 1, 'salesforce', 'canonical-mixed-document-hash', 'canonical mixed', '2026-08-01', 'authoritative_system', 'salesforce/opportunities.tsv#canonical-mixed', 'canonical_rule', ${'b'.repeat(64)})`;
    await sql`insert into evidence_versions
      (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash, embedding, embedding_provider, embedding_model, embedding_dimension, embedding_profile, embedding_version, embedding_normalization)
      values (${`evidence_canonical_mixed_${suffix}`}, ${canonicalMixedDocument}, ${seeded.accountId}, ${seeded.opportunityId}, 0, 'salesforce', 'standard', 'canonical-mixed-hash', 'canonical mixed', '2026-08-01', 'authoritative_system', 'salesforce/opportunities.tsv#canonical-mixed:0', 'canonical_rule', ${'b'.repeat(64)}, '[1,0]'::vector, 'other', 'other', 2, 'other', 'v9', 'l2')`;
    await expect(new EmbeddingIndexer(database, mock.embeddingGateway, profile, { corpus }).index()).rejects.toThrow('mixed embedding profiles');
  });

  it('lets concurrent same-profile indexers converge and rejects a concurrent different profile', async () => {
    const seeded = await seed();
    const suffix = randomUUID().replaceAll('-', '');
    const insertCorpusRow = async (key: string, prefix: string) => {
      const documentId = `document_concurrent_${key}_${suffix}`;
      await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
        values (${documentId}, ${documentId}, 1, 'salesforce', ${`doc-${key}`}, ${`concurrent ${key}`}, '2026-08-01', 'authoritative_system', ${`${prefix}document`}, 'canonical_rule', ${'c'.repeat(64)})`;
      await sql`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
        values (${`evidence_concurrent_${key}_${suffix}`}, ${documentId}, ${seeded.accountId}, ${seeded.opportunityId}, 0, 'salesforce', 'standard', ${`chunk-${key}`}, ${`concurrent ${key}`}, '2026-08-01', 'authoritative_system', ${`${prefix}evidence`}, 'canonical_rule', ${'c'.repeat(64)})`;
    };
    const makeBarrierGateway = () => {
      let arrivals = 0;
      let release: (() => void) | undefined;
      const barrier = new Promise<void>((resolveBarrier) => { release = resolveBarrier; });
      return {
        async embed(values: readonly string[]) {
          arrivals += 1;
          if (arrivals === 2) release?.();
          await barrier;
          return mock.embeddingGateway.embed(values);
        }
      };
    };
    const samePrefix = `concurrent/same/${suffix}/`;
    await insertCorpusRow('same', samePrefix);
    const sameGateway = makeBarrierGateway();
    const sameResults = await Promise.all([
      new EmbeddingIndexer(database, sameGateway, profile, { corpus: { sourceLocatorPrefixes: [samePrefix], requireCompleteProvenance: true } }).index(),
      new EmbeddingIndexer(database, sameGateway, profile, { corpus: { sourceLocatorPrefixes: [samePrefix], requireCompleteProvenance: true } }).index()
    ]);
    expect(sameResults.reduce((sum, result) => sum + result.indexed, 0)).toBe(1);

    const mixedPrefix = `concurrent/mixed/${suffix}/`;
    await insertCorpusRow('mixed', mixedPrefix);
    const mixedGateway = makeBarrierGateway();
    const mixedResults = await Promise.allSettled([
      new EmbeddingIndexer(database, mixedGateway, profile, { corpus: { sourceLocatorPrefixes: [mixedPrefix], requireCompleteProvenance: true } }).index(),
      new EmbeddingIndexer(database, mixedGateway, { ...profile, model: 'concurrent-other' }, { corpus: { sourceLocatorPrefixes: [mixedPrefix], requireCompleteProvenance: true } }).index()
    ]);
    expect(mixedResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(mixedResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('fails closed when a canonical locator candidate has incomplete provenance', async () => {
    const seeded = await seed();
    const suffix = randomUUID().replaceAll('-', '');
    const prefix = `canonical/incomplete/${suffix}/`;
    const documentId = `document_incomplete_${suffix}`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
      values (${documentId}, ${documentId}, 1, 'salesforce', 'incomplete-doc', 'incomplete', '2026-08-01', 'authoritative_system', ${`${prefix}document`}, 'canonical_rule', ${'d'.repeat(64)})`;
    await sql`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content)
      values (${`evidence_incomplete_${suffix}`}, ${documentId}, ${seeded.accountId}, ${seeded.opportunityId}, 0, 'salesforce', 'standard', 'incomplete-chunk', 'incomplete')`;
    await expect(new EmbeddingIndexer(database, mock.embeddingGateway, profile, {
      corpus: { sourceLocatorPrefixes: [prefix], requireCompleteProvenance: true }
    }).index()).rejects.toThrow('provenance is incomplete');
  });
});

describe('authorized hybrid retrieval and citations', () => {
  const authorizedScope = (seeded: Awaited<ReturnType<typeof seed>>) => ({
    personaId: seeded.userId, allowed: true as const, accountIds: [seeded.accountId],
    sourceTypes: ['policy', 'pricing', 'salesforce', 'slack'] as const,
    canViewSensitivePricing: false, canRequestApproval: true, canApprove: false, canViewRestrictedAccounts: false
  });

  it('binds the persisted run to the requested opportunity and persona before retrieval or manifest persistence', async () => {
    const opportunityMismatch = await seed();
    const retriever = new PostgresHybridEvidenceRetriever(database, mock.embeddingGateway, profile);
    await expect(retriever.search({
      query: 'termination', accountId: opportunityMismatch.accountId, opportunityId: `${opportunityMismatch.opportunityId}_wrong`,
      runId: opportunityMismatch.runId, limit: 3, scope: authorizedScope(opportunityMismatch)
    })).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(sql`select id from run_evidence_manifests where run_id = ${opportunityMismatch.runId}`).resolves.toHaveLength(0);

    const personaMismatch = await seed();
    await expect(retriever.search({
      query: 'termination', accountId: personaMismatch.accountId, opportunityId: personaMismatch.opportunityId,
      runId: personaMismatch.runId, limit: 3,
      scope: { ...authorizedScope(personaMismatch), personaId: personaMismatch.deniedUserId }
    })).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(sql`select id from run_evidence_manifests where run_id = ${personaMismatch.runId}`).resolves.toHaveLength(0);
  });

  it('refuses retrieval while the active embedding index is incomplete', async () => {
    const seeded = await seed();
    const retriever = new PostgresHybridEvidenceRetriever(database, mock.embeddingGateway, profile);
    await expect(retriever.search({
      query: 'termination', accountId: seeded.accountId, opportunityId: seeded.opportunityId, runId: seeded.runId, limit: 3,
      scope: { personaId: seeded.userId, allowed: true, accountIds: [seeded.accountId], sourceTypes: ['policy', 'salesforce'], canViewSensitivePricing: false, canRequestApproval: true, canApprove: false, canViewRestrictedAccounts: false }
    })).rejects.toThrow('index is not ready');
  });

  it('filters before lexical and vector rank, includes policy, budgets context, and persists a complete immutable manifest', async () => {
    const seeded = await seed();
    await new EmbeddingIndexer(database, mock.embeddingGateway, profile, { batchSize: 10, corpus: seededFixtureCorpus }).index();
    const retriever = new PostgresHybridEvidenceRetriever(database, mock.embeddingGateway, profile);
    const results = await retriever.search({
      query: 'non-standard termination clause', accountId: seeded.accountId, opportunityId: seeded.opportunityId,
      runId: seeded.runId, limit: 3, maxContextCharacters: 500,
      scope: { personaId: seeded.userId, allowed: true, accountIds: [seeded.accountId], sourceTypes: ['policy', 'pricing', 'salesforce', 'slack'], canViewSensitivePricing: false, canRequestApproval: true, canApprove: false, canViewRestrictedAccounts: false }
    });
    expect(results.evidence.some((entry) => entry.sourceType === 'policy')).toBe(true);
    expect(results.evidence.some((entry) => entry.sourceType === 'pricing')).toBe(false);
    expect(results.manifest.policyHash).toBe('a'.repeat(64));
    expect(results.evidence.reduce((sum, entry) => sum + entry.content.length, 0)).toBeLessThanOrEqual(500);
    expect(results.diagnostics.missingSourceTypes).toContain('pricing');
    const manifests = await sql<{ query_hash: string; scope_hash: string; policy_hash: string; index_profile: string }[]>`
      select query_hash, scope_hash, policy_hash, index_profile from run_evidence_manifests where id = ${results.manifest.id}`;
    expect(manifests).toEqual([expect.objectContaining({ query_hash: expect.stringMatching(/^[0-9a-f]{64}$/), scope_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    const entries = await sql<{ source_locator: string; classification_reason: string; source_type: string; query_rank: number }[]>`
      select source_locator, classification_reason, source_type, query_rank from run_evidence_manifest_entries where manifest_id = ${results.manifest.id}`;
    expect(entries).toHaveLength(results.evidence.length);
    expect(entries.every((entry) => entry.source_locator.length > 0 && entry.classification_reason.length > 0 && entry.query_rank > 0)).toBe(true);
    await expect(sql`update run_evidence_manifest_entries set score = 99 where manifest_id = ${results.manifest.id}`).rejects.toThrow('immutable');
  });

  it('executes fixed section queries and exact account, opportunity, and contact lookups', async () => {
    const seeded = await seed();
    await new EmbeddingIndexer(database, mock.embeddingGateway, profile, { corpus: seededFixtureCorpus }).index();
    const embedded: string[] = [];
    const gateway = { async embed(values: readonly string[]) { embedded.push(...values); return mock.embeddingGateway.embed(values); } };
    const result = await new PostgresHybridEvidenceRetriever(database, gateway, profile).search({
      query: 'termination', accountId: seeded.accountId, opportunityId: seeded.opportunityId, runId: seeded.runId, limit: 3,
      scope: authorizedScope(seeded)
    });
    const plan = buildEvidencePlan({ query: 'termination', limit: 3 });
    expect(embedded).toEqual([plan.query, ...plan.sectionQueries.map((section) => section.query)]);
    expect(result.diagnostics.exactLookups).toEqual({ account: 1, opportunity: 1, contacts: 0 });
    expect(Object.keys(result.diagnostics.sectionMatches)).toEqual(plan.sectionQueries.map((section) => section.section));
  });

  it('reserves a result and context budget for mandatory policy evidence', async () => {
    const seeded = await seed();
    await new EmbeddingIndexer(database, mock.embeddingGateway, profile, { corpus: seededFixtureCorpus }).index();
    const result = await new PostgresHybridEvidenceRetriever(database, mock.embeddingGateway, profile).search({
      query: 'buyer termination', accountId: seeded.accountId, opportunityId: seeded.opportunityId, runId: seeded.runId,
      limit: 2, maxContextCharacters: 20, scope: authorizedScope(seeded)
    });
    const policy = result.evidence.find((entry) => entry.sourceType === 'policy');
    expect(policy?.content.length).toBeGreaterThan(0);
    expect(result.evidence.reduce((sum, entry) => sum + entry.content.length, 0)).toBeLessThanOrEqual(20);
    expect(result.diagnostics.mandatoryPolicy).toBe('included');
  });

  it('replays the same immutable manifest idempotently and conflicts on changed inputs', async () => {
    const seeded = await seed();
    await new EmbeddingIndexer(database, mock.embeddingGateway, profile, { corpus: seededFixtureCorpus }).index();
    const retriever = new PostgresHybridEvidenceRetriever(database, mock.embeddingGateway, profile, () => new Date('2026-08-28T00:00:00.000Z'));
    const request = { query: 'termination', accountId: seeded.accountId, opportunityId: seeded.opportunityId, runId: seeded.runId, limit: 3, maxContextCharacters: 500, scope: authorizedScope(seeded) };
    const [first, concurrentReplay] = await Promise.all([retriever.search(request), retriever.search(request)]);
    expect(concurrentReplay).toEqual(first);
    const replay = await retriever.search(request);
    expect(replay).toEqual(first);
    await expect(sql`select id from run_evidence_manifests where run_id = ${seeded.runId}`).resolves.toHaveLength(1);
    await expect(retriever.search({ ...request, query: 'changed retrieval intent' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects inconsistent canonical policy content hashes before ranking', async () => {
    const seeded = await seed();
    const suffix = randomUUID().replaceAll('-', '');
    const documentId = `document_policy_conflict_${suffix}`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
      values (${documentId}, ${documentId}, 1, 'salesforce', 'conflict-doc', 'conflicting policy lineage', '2026-08-01', 'authoritative_system', 'fixture#sf-conflict', 'test_classification', ${'b'.repeat(64)})`;
    await sql`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
      values (${`evidence_policy_conflict_${suffix}`}, ${documentId}, ${seeded.accountId}, ${seeded.opportunityId}, 0, 'salesforce', 'standard', 'conflict-chunk', 'conflicting policy lineage', '2026-08-01', 'authoritative_system', 'fixture#sf-conflict:0', 'test_classification', ${'b'.repeat(64)})`;
    await new EmbeddingIndexer(database, mock.embeddingGateway, profile, { corpus: seededFixtureCorpus }).index();
    await expect(new PostgresHybridEvidenceRetriever(database, mock.embeddingGateway, profile).search({
      query: 'termination', accountId: seeded.accountId, opportunityId: seeded.opportunityId, runId: seeded.runId, limit: 3,
      scope: authorizedScope(seeded)
    })).rejects.toThrow('Inconsistent policy hashes');
  });

  it('uses exact cosine search and preserves full authorized recall against the unfiltered baseline', async () => {
    const seeded = await seed();
    await new EmbeddingIndexer(database, mock.embeddingGateway, profile, { corpus: seededFixtureCorpus }).index();
    const [queryEmbedding] = await mock.embeddingGateway.embed(['termination']);
    const literal = `[${queryEmbedding!.join(',')}]`;
    const baseline = await sql<{ id: string; source_type: string; sensitivity: string }[]>`
      select id, source_type, sensitivity from evidence_versions
      where account_id = ${seeded.accountId} and opportunity_id = ${seeded.opportunityId}
        and embedding_provider = ${profile.provider} and embedding_model = ${profile.model}
        and embedding_profile = ${profile.profile} and embedding_dimension = ${profile.dimension}
      order by embedding <=> ${literal}::vector, id`;
    const selective = await sql<{ id: string }[]>`
      select evidence.id from evidence_versions evidence join opportunities opportunity on opportunity.id = evidence.opportunity_id
      where evidence.account_id = ${seeded.accountId} and evidence.opportunity_id = ${seeded.opportunityId}
        and evidence.embedding_provider = ${profile.provider} and evidence.embedding_model = ${profile.model}
        and evidence.embedding_profile = ${profile.profile} and evidence.embedding_dimension = ${profile.dimension}
        and evidence.sensitivity <> 'restricted'
        and exists (select 1 from permission_grants permission where permission.persona_id = ${seeded.userId}
          and permission.can_read = true and (permission.account_id is null or permission.account_id = evidence.account_id)
          and (permission.source_type is null or permission.source_type = evidence.source_type))
      order by evidence.embedding <=> ${literal}::vector, evidence.id`;
    const expectedAuthorized = baseline.filter((row) => row.sensitivity !== 'restricted').map((row) => row.id);
    expect(selective.map((row) => row.id)).toEqual(expectedAuthorized);
    expect(new Set(selective.map((row) => row.id)).size / new Set(expectedAuthorized).size).toBe(1);
    const explain = await sql<Record<string, unknown>[]>`explain (format json)
      select evidence.id from evidence_versions evidence
      where evidence.account_id = ${seeded.accountId} and evidence.opportunity_id = ${seeded.opportunityId}
        and evidence.embedding_provider = ${profile.provider} and evidence.embedding_model = ${profile.model}
      order by evidence.embedding <=> ${literal}::vector, evidence.id`;
    expect(JSON.stringify(explain).toLowerCase()).not.toMatch(/hnsw|ivfflat|approximate/);
  });

  it('returns nothing when the caller has no effective evidence scope', async () => {
    const seeded = await seed();
    const deniedRunId = `${seeded.runId}_denied`;
    await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model)
      values (${deniedRunId}, ${seeded.opportunityId}, ${seeded.deniedUserId}, 'retrieving', 'mock', 'mock-brief')`;
    await new EmbeddingIndexer(database, mock.embeddingGateway, profile, { corpus: seededFixtureCorpus }).index();
    const retriever = new PostgresHybridEvidenceRetriever(database, mock.embeddingGateway, profile);
    const result = await retriever.search({
      query: 'termination', accountId: seeded.accountId, opportunityId: seeded.opportunityId, runId: deniedRunId, limit: 10,
      scope: { personaId: seeded.deniedUserId, allowed: true, accountIds: [seeded.accountId], sourceTypes: ['salesforce'], canViewSensitivePricing: false, canRequestApproval: false, canApprove: false, canViewRestrictedAccounts: false }
    });
    expect(result.evidence).toEqual([]);
    expect(result.diagnostics).toEqual(expect.objectContaining({ returned: 0, contextCharacters: 0, missingSourceTypes: [] }));
  });

  it('resolves only current authorized in-manifest citations and makes every denial opaque', async () => {
    const seeded = await seed();
    await new EmbeddingIndexer(database, mock.embeddingGateway, profile, { corpus: seededFixtureCorpus }).index();
    const retriever = new PostgresHybridEvidenceRetriever(database, mock.embeddingGateway, profile);
    const result = await retriever.search({
      query: 'termination', accountId: seeded.accountId, opportunityId: seeded.opportunityId, runId: seeded.runId, limit: 3,
      scope: { personaId: seeded.userId, allowed: true, accountIds: [seeded.accountId], sourceTypes: ['policy', 'salesforce', 'slack'], canViewSensitivePricing: false, canRequestApproval: true, canApprove: false, canViewRestrictedAccounts: false }
    });
    const citationId = result.evidence[0]?.citationId;
    expect(citationId).toBeDefined();
    const resolver = new PostgresCitationResolver(database);
    const allowed = await resolver.resolve({
      manifestId: result.manifest.id, citationId: citationId!, scope: { personaId: seeded.userId, allowed: true, accountIds: [seeded.accountId], sourceTypes: ['policy', 'salesforce', 'slack'], canViewSensitivePricing: false, canRequestApproval: true, canApprove: false, canViewRestrictedAccounts: false }
    });
    expect(allowed.citationId).toBe(citationId);
    const denials = [
      () => resolver.resolve({ manifestId: result.manifest.id, citationId: 'citation_missing', scope: { personaId: seeded.userId, allowed: true, accountIds: [seeded.accountId], sourceTypes: ['policy'], canViewSensitivePricing: false, canRequestApproval: false, canApprove: false, canViewRestrictedAccounts: false } }),
      () => resolver.resolve({ manifestId: result.manifest.id, citationId: citationId!, scope: { personaId: seeded.deniedUserId, allowed: true, accountIds: [seeded.accountId], sourceTypes: ['salesforce'], canViewSensitivePricing: false, canRequestApproval: false, canApprove: false, canViewRestrictedAccounts: false } })
    ];
    for (const denial of denials) {
      const error: unknown = await denial().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'AUTHORIZATION_DENIED', safeMessage: 'You are not allowed to perform this action.', details: {} });
      expect(error).toBeInstanceOf(AuthorizationDeniedError);
    }
  });
});
