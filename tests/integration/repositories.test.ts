import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '@slacato/infrastructure/db/client';
import { PostgresEvidenceRepository } from '@slacato/infrastructure/db/repositories/evidence-repository';
import { PostgresGenerationAttemptStore } from '@slacato/infrastructure/db/repositories/generation-attempt-store';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const clients: ReturnType<typeof postgres>[] = [];

function openDatabase(): ReturnType<typeof postgres> {
  const client = postgres(databaseUrl, { max: 1 });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.end({ timeout: 1 })));
});

describe('PostgreSQL repository contract', () => {
  it('persists the run before any generation attempt can exist', async () => {
    const sql = openDatabase();
    const runId = `run_repository_${crypto.randomUUID().replaceAll('-', '')}`;
    const opportunityId = `opportunity_repository_${crypto.randomUUID().replaceAll('-', '')}`;
    const userId = `user_repository_${crypto.randomUUID().replaceAll('-', '')}`;
    const accountId = `account_repository_${crypto.randomUUID().replaceAll('-', '')}`;

    await sql`insert into personas (id, display_name, role) values (${userId}, 'Repository user', 'seller')`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Repository account')`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Repository opportunity')`;

    await sql`
      insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, version)
      values (${runId}, ${opportunityId}, ${userId}, 'created', 'mock', 'mock-chat', 0)
    `;

    const runs = await sql<{ id: string; status: string }[]>`
      select id, status from runs where id = ${runId}
    `;
    const attempts = await sql<{ count: string }[]>`
      select count(*)::text as count from generation_attempts where run_id = ${runId}
    `;

    expect(runs).toEqual([{ id: runId, status: 'created' }]);
    expect(attempts).toEqual([{ count: '0' }]);
  });

  it('keeps embeddings dimension-flexible while retaining searchable profile metadata', async () => {
    const sql = openDatabase();
    const vectorColumn = await sql<{ atttypmod: number }[]>`
      select attribute.atttypmod
      from pg_attribute attribute
      join pg_class relation on relation.oid = attribute.attrelid
      where relation.relname = 'evidence_versions' and attribute.attname = 'embedding'
    `;
    const generatedLexicalColumn = await sql<{ attgenerated: string }[]>`
      select attribute.attgenerated
      from pg_attribute attribute
      join pg_class relation on relation.oid = attribute.attrelid
      where relation.relname = 'evidence_versions' and attribute.attname = 'lexical_content'
    `;
    const indexes = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'evidence_versions'
    `;

    expect(vectorColumn).toEqual([{ atttypmod: -1 }]);
    expect(generatedLexicalColumn).toEqual([{ attgenerated: 's' }]);
    expect(indexes.some((entry) => entry.indexdef.includes('USING gin (lexical_content)'))).toBe(true);
    expect(indexes.some((entry) => entry.indexdef.includes('hnsw'))).toBe(false);
  });

  it('rejects mutation of an immutable manifest entry', async () => {
    const sql = openDatabase();
    const id = crypto.randomUUID().replaceAll('-', '');
    const userId = `user_manifest_${id}`;
    const accountId = `account_manifest_${id}`;
    const opportunityId = `opportunity_manifest_${id}`;
    const runId = `run_manifest_${id}`;
    const documentId = `document_manifest_${id}`;
    const evidenceId = `evidence_manifest_${id}`;
    const manifestId = `manifest_manifest_${id}`;
    await sql`insert into personas (id, display_name, role) values (${userId}, 'Manifest user', 'seller')`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Manifest account')`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Manifest opportunity')`;
    await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, version) values (${runId}, ${opportunityId}, ${userId}, 'created', 'mock', 'mock-chat', 0)`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content) values (${documentId}, ${documentId}, 1, 'crm', 'document-hash', 'immutable content')`;
    await sql`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content) values (${evidenceId}, ${documentId}, ${accountId}, ${opportunityId}, 0, 'crm', 'internal', 'evidence-hash', 'immutable evidence')`;
    await sql`insert into run_evidence_manifests (id, run_id, scope_hash, policy_hash, index_profile) values (${manifestId}, ${runId}, 'scope-hash', 'policy-hash', 'profile-hash')`;
    await sql`insert into run_evidence_manifest_entries (manifest_id, evidence_version_id, rank, score, content_hash) values (${manifestId}, ${evidenceId}, 1, 1, 'evidence-hash')`;
    await expect(sql`update run_evidence_manifest_entries set rank = 2 where manifest_id = ${manifestId} and evidence_version_id = ${evidenceId}`).rejects.toThrow('immutable');
  });

  it('filters the complete embedding profile before exact cosine ranking', async () => {
    const sql = openDatabase();
    const id = crypto.randomUUID().replaceAll('-', '');
    const accountId = `account_embedding_${id}`;
    const opportunityId = `opportunity_embedding_${id}`;
    const documentId = `document_embedding_${id}`;
    const matchingId = `evidence_embedding_match_${id}`;
    const mismatchedId = `evidence_embedding_mismatch_${id}`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Embedding account')`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Embedding opportunity')`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content) values (${documentId}, ${documentId}, 1, 'crm', 'embedding-document-hash', 'search content')`;
    await sql`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, embedding, embedding_provider, embedding_model, embedding_dimension, embedding_profile, embedding_version, embedding_normalization)
      values (${matchingId}, ${documentId}, ${accountId}, ${opportunityId}, 0, 'crm', 'internal', 'embedding-hash-a', 'matching', '[1,0]'::vector, 'mock', 'mock-embedding', 2, 'mock-profile', 'v1', 'l2')`;
    await sql`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, embedding, embedding_provider, embedding_model, embedding_dimension, embedding_profile, embedding_version, embedding_normalization)
      values (${mismatchedId}, ${documentId}, ${accountId}, ${opportunityId}, 1, 'crm', 'internal', 'embedding-hash-b', 'mismatched', '[1,0]'::vector, 'other', 'other-embedding', 2, 'other-profile', 'v1', 'l2')`;
    const database = createDatabaseClient(databaseUrl, 1);
    const repository = new PostgresEvidenceRepository(database);
    const results = await repository.searchExactCosine({
      accountId: accountId as never, opportunityId: opportunityId as never, embedding: [1, 0], limit: 5,
      profile: { provider: 'mock', model: 'mock-embedding', dimension: 2, profile: 'mock-profile', version: 'v1', normalization: 'l2' }
    });
    await database.close();
    expect(results).toEqual([{ evidenceId: matchingId, similarity: 1 }]);
    await expect(repository.searchExactCosine({
      accountId: accountId as never, opportunityId: opportunityId as never, embedding: [1], limit: 5,
      profile: { provider: 'mock', model: 'mock-embedding', dimension: 2, profile: 'mock-profile', version: 'v1', normalization: 'l2' }
    })).rejects.toThrow('dimension');
  });

  it('records attempt_started before settling provider IDs and usage', async () => {
    const sql = openDatabase();
    const id = crypto.randomUUID().replaceAll('-', '');
    const userId = `user_attempt_${id}`;
    const accountId = `account_attempt_${id}`;
    const opportunityId = `opportunity_attempt_${id}`;
    const runId = `run_attempt_${id}`;
    const attemptId = `attempt_${id}`;
    await sql`insert into personas (id, display_name, role) values (${userId}, 'Attempt user', 'seller')`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Attempt account')`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Attempt opportunity')`;
    await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, version) values (${runId}, ${opportunityId}, ${userId}, 'created', 'mock', 'mock-chat', 0)`;
    const database = createDatabaseClient(databaseUrl, 1);
    const attempts = new PostgresGenerationAttemptStore(database);
    await attempts.recordAttemptStarted({ id: attemptId, runId: runId as never, operation: 'specialist', provider: 'mock', model: 'mock-chat' });
    expect((await sql<{ status: string; response_id: string | null }[]>`select status, response_id from generation_attempts where id = ${attemptId}`)[0]).toEqual({ status: 'attempt_started', response_id: null });
    await attempts.completeAttempt({ id: attemptId, status: 'possible_duplicate', possibleDuplicate: true, requestId: 'provider-request', responseId: 'provider-response', inputTokens: 12, outputTokens: 34 });
    expect((await sql<{ status: string; possible_duplicate: boolean; input_tokens: number; output_tokens: number }[]>`select status, possible_duplicate, input_tokens, output_tokens from generation_attempts where id = ${attemptId}`)[0]).toEqual({ status: 'possible_duplicate', possible_duplicate: true, input_tokens: 12, output_tokens: 34 });
    await database.close();
  });
});
