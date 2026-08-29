import postgres from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NestFactory } from '@nestjs/core';
import { createDatabaseClient } from '@slacato/infrastructure/db/client';
import { envSchema } from '@slacato/infrastructure/config/env';
import { PostgresEvidenceRepository } from '@slacato/infrastructure/db/repositories/evidence-repository';
import { PostgresProviderAttemptLedger } from '@slacato/infrastructure/db/repositories/provider-attempt-ledger';
import { logger } from '@slacato/infrastructure';
import { PostgresWorkflowStore } from '@slacato/infrastructure/db/repositories/workflow-store';
import { createBudgetedModelGateway, ProviderAttemptFinalizationConflict, type ModelTransport } from '@slacato/core';
import { createWorkerCompositionModule, WorkerModelGatewayFactory } from '../../apps/worker/src/main';

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
  it('persists attempt_started before the real generic gateway invokes its mock provider', async () => {
    const sql = openDatabase(); const id = crypto.randomUUID().replaceAll('-', '');
    const userId = `user_gateway_${id}`; const accountId = `account_gateway_${id}`; const opportunityId = `opportunity_gateway_${id}`; const runId = `run_gateway_${id}`;
    await sql`insert into personas (id, display_name, role) values (${userId}, 'Gateway user', 'seller')`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Gateway account')`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Gateway opportunity')`;
    await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, version) values (${runId}, ${opportunityId}, ${userId}, 'created', 'mock', 'mock-chat', 0)`;
    await sql`insert into run_budgets (run_id, max_calls, max_input_tokens, max_output_tokens) values (${runId}, 1, 100, 20)`;
    const database = createDatabaseClient(databaseUrl, 1);
    const ledger = new PostgresProviderAttemptLedger(database);
    let startedBeforeTransport = false;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() {
        const rows = await sql<{ count: string }[]>`select count(*)::text as count from generation_attempts where run_id = ${runId} and status = 'attempt_started'`;
        startedBeforeTransport = rows[0]?.count === '1';
        return { text: '{"items":[]}', usage: { inputTokens: 1, outputTokens: 2 } };
      }
    };
    await createBudgetedModelGateway(transport, undefined, ledger).generateObject({
      schema: z.object({ items: z.array(z.string()) }).strict(), messages: [{ role: 'user', content: 'Return items.' }], operation: 'gateway-ledger',
      durableAttempt: { runScope: runId, provider: 'mock', model: 'mock-chat' },
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 100, maxOutputTokens: 20 }
    });
    expect(startedBeforeTransport).toBe(true);
    await database.close();
  });

  it('configured production composition exposes only a verified run-scoped gateway', async () => {
    const sql = openDatabase(); const id = crypto.randomUUID().replaceAll('-', '');
    const userId = `user_composed_${id}`; const accountId = `account_composed_${id}`; const opportunityId = `opportunity_composed_${id}`; const runId = `run_composed_${id}`;
    await sql`insert into personas (id, display_name, role) values (${userId}, 'Composed user', 'seller')`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Composed account')`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Composed opportunity')`;
    const database = createDatabaseClient(databaseUrl, 1);
    await new PostgresWorkflowStore(database).startRun({
      id: runId as never, opportunityId: opportunityId as never, requestedBy: userId as never, status: 'created', generationProvider: 'mock', generationModel: 'mock-brief',
      idempotencyKey: `composed_${id}`, startRequestHash: 'a'.repeat(64),
      command: { id: `command_composed_${id}`, runId: runId as never, type: 'process-step', payload: { step: 'start' }, idempotencyKey: `composed_${id}` },
      budget: { scope: runId as never, maxCalls: 2, maxInputTokens: 100, maxOutputTokens: 20, deadlineMs: 1_000 }
    });
    const environment = envSchema.parse({
      NODE_ENV: 'test', DATABASE_URL: databaseUrl, SESSION_SECRET: 'a-session-secret-that-is-at-least-32-characters'
    });
    const app = await NestFactory.createApplicationContext(createWorkerCompositionModule(environment, database));
    const factory = app.get(WorkerModelGatewayFactory);
    expect(() => factory.create()).toThrow('fixture resolver');
    const gateways = factory.create({ mockFixtureResolver: async () => ({ text: '{"items":[]}', usage: { inputTokens: 1, outputTokens: 2 } }) });
    expect('modelGateway' in gateways).toBe(false);
    await expect(gateways.forRun({ runScope: `missing_${id}`, budget: { scope: `missing_${id}`, maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 20, deadlineMs: 1_000 } })).rejects.toThrow('Run budget does not exist');
    const run = await gateways.forRun({ runScope: runId, budget: { scope: runId, maxCalls: 2, maxInputTokens: 100, maxOutputTokens: 20, deadlineMs: 1_000 } });
    await run.generateObject({
      schema: z.object({ items: z.array(z.string()) }).strict(), messages: [{ role: 'user', content: 'Return items.' }], operation: 'composed-specialist',
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 100, maxOutputTokens: 20 }
    });
    const embeddings = await gateways.embeddingForRun({
      runScope: runId, logicalGenerationId: `retrieval_${id}`,
      budget: { scope: runId, maxCalls: 2, maxInputTokens: 100, maxOutputTokens: 20, deadlineMs: 1_000 }
    });
    await embeddings.embed(['authorized retrieval query']);
    expect(await sql<{ operation: string; status: string }[]>`select operation, status from generation_attempts where run_id = ${runId} order by operation`).toEqual([
      { operation: 'composed-specialist', status: 'completed' },
      { operation: 'retrieval-embedding', status: 'completed' }
    ]);
    await app.close(); await database.close();
  });

  it('atomically creates the run and its budget, validates exact replay, and rolls both back on a command conflict', async () => {
    const sql = openDatabase(); const id = crypto.randomUUID().replaceAll('-', '');
    const userId = `user_start_${id}`; const accountId = `account_start_${id}`; const opportunityId = `opportunity_start_${id}`; const runId = `run_start_${id}`; const rejectedRunId = `run_start_rejected_${id}`;
    await sql`insert into personas (id, display_name, role) values (${userId}, 'Start user', 'seller')`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Start account')`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Start opportunity')`;
    const database = createDatabaseClient(databaseUrl, 1); const store = new PostgresWorkflowStore(database);
    const budget = { scope: runId as never, maxCalls: 2, maxInputTokens: 100, maxOutputTokens: 20, deadlineMs: 1_000 };
    const command = { id: `command_start_${id}`, runId: runId as never, type: 'process-step', payload: { step: 'start' }, idempotencyKey: `start_${id}` };
    const input = { id: runId as never, opportunityId: opportunityId as never, requestedBy: userId as never, status: 'created' as const, generationProvider: 'mock', generationModel: 'mock-chat', command, budget };
    await store.startRun(input);
    await store.startRun(input);
    expect(await sql<{ run_id: string; max_calls: number; deadline_ms: number }[]>`select run_budgets.run_id, run_budgets.max_calls, run_budgets.deadline_ms from run_budgets where run_id = ${runId}`).toEqual([{ run_id: runId, max_calls: 2, deadline_ms: 1_000 }]);
    await expect(store.startRun({ ...input, budget: { ...budget, maxCalls: 3 } })).rejects.toThrow('budget limits');
    await expect(store.startRun({ ...input, budget: { ...budget, deadlineMs: 2_000 } })).rejects.toThrow('budget limits');
    const rejectedCommand = { ...command, runId: rejectedRunId as never };
    await expect(store.startRun({ ...input, id: rejectedRunId as never, command: rejectedCommand, budget: { ...budget, scope: rejectedRunId as never } })).rejects.toThrow('Outbox idempotency');
    expect(await sql<{ run_count: string; budget_count: string }[]>`select
      (select count(*)::text from runs where id = ${rejectedRunId}) as run_count,
      (select count(*)::text from run_budgets where run_id = ${rejectedRunId}) as budget_count`).toEqual([{ run_count: '0', budget_count: '0' }]);
    await database.close();
  });

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
    await sql`insert into run_evidence_manifests
      (id, run_id, scope_hash, policy_hash, query_hash, index_profile, embedding_provider, embedding_model, embedding_dimension, embedding_version, embedding_normalization, context_limit, diagnostics)
      values (${manifestId}, ${runId}, 'scope-hash', 'policy-hash', ${'0'.repeat(64)}, 'profile-hash', 'mock', 'mock-embedding', 2, 'v1', 'l2', 100, '{}'::jsonb)`;
    await sql`insert into run_evidence_manifest_entries
      (manifest_id, evidence_version_id, citation_id, rank, query_rank, score, content_hash, source_locator, source_type, sensitivity, classification_reason, policy_hash, fusion_score, reliability_adjustment, recency_adjustment, included_characters)
      values (${manifestId}, ${evidenceId}, ${`citation_${id}`}, 1, 1, 1, 'evidence-hash', 'test#manifest', 'crm', 'internal', 'test', 'policy-hash', 1, 0, 0, 10)`;
    await expect(sql`update run_evidence_manifest_entries set rank = 2 where manifest_id = ${manifestId} and evidence_version_id = ${evidenceId}`).rejects.toThrow('immutable');
  });

  it('filters the complete embedding profile before exact cosine ranking', async () => {
    const sql = openDatabase();
    const id = crypto.randomUUID().replaceAll('-', '');
    const accountId = `account_embedding_${id}`;
    const userId = `user_embedding_${id}`;
    const opportunityId = `opportunity_embedding_${id}`;
    const documentId = `document_embedding_${id}`;
    const matchingId = `evidence_embedding_match_${id}`;
    const mismatchedId = `evidence_embedding_mismatch_${id}`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Embedding account')`;
    await sql`insert into personas (id, display_name, role) values (${userId}, 'Embedding user', 'seller')`;
    await sql`insert into permission_grants (id, persona_id, account_id, can_read, sensitive_pricing) values (${`grant_embedding_${id}`}, ${userId}, ${accountId}, true, false)`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Embedding opportunity')`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content) values (${documentId}, ${documentId}, 1, 'crm', 'embedding-document-hash', 'search content')`;
    await sql`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, embedding, embedding_provider, embedding_model, embedding_dimension, embedding_profile, embedding_version, embedding_normalization)
      values (${matchingId}, ${documentId}, ${accountId}, ${opportunityId}, 0, 'crm', 'internal', 'embedding-hash-a', 'matching', '[1,0]'::vector, 'mock', 'mock-embedding', 2, 'mock-profile', 'v1', 'l2')`;
    await sql`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, embedding, embedding_provider, embedding_model, embedding_dimension, embedding_profile, embedding_version, embedding_normalization)
      values (${mismatchedId}, ${documentId}, ${accountId}, ${opportunityId}, 1, 'crm', 'internal', 'embedding-hash-b', 'mismatched', '[1,0]'::vector, 'other', 'other-embedding', 2, 'other-profile', 'v1', 'l2')`;
    const database = createDatabaseClient(databaseUrl, 1);
    const repository = new PostgresEvidenceRepository(database);
    const results = await repository.searchExactCosine({
      access: { personaId: userId as never, allowSensitivePricing: false }, accountId: accountId as never, opportunityId: opportunityId as never, embedding: [1, 0], limit: 5,
      profile: { provider: 'mock', model: 'mock-embedding', dimension: 2, profile: 'mock-profile', version: 'v1', normalization: 'l2' }
    });
    await database.close();
    expect(results).toEqual([{ evidenceId: matchingId, similarity: 1 }]);
    await expect(repository.searchExactCosine({
      access: { personaId: userId as never, allowSensitivePricing: false }, accountId: accountId as never, opportunityId: opportunityId as never, embedding: [1], limit: 5,
      profile: { provider: 'mock', model: 'mock-embedding', dimension: 2, profile: 'mock-profile', version: 'v1', normalization: 'l2' }
    })).rejects.toThrow('dimension');
  });

  it('returns each authorized evidence version once before exact-cosine top-K ranking', async () => {
    const sql = openDatabase();
    const id = crypto.randomUUID().replaceAll('-', '');
    const accountId = `account_authorized_${id}`;
    const userId = `user_authorized_${id}`;
    const opportunityId = `opportunity_authorized_${id}`;
    const restrictedOpportunityId = `opportunity_restricted_${id}`;
    const documentId = `document_authorized_${id}`;
    const firstId = `evidence_authorized_first_${id}`;
    const secondId = `evidence_authorized_second_${id}`;
    const thirdId = `evidence_authorized_third_${id}`;
    const deniedSourceId = `evidence_authorized_denied_source_${id}`;
    const deniedSensitivityId = `evidence_authorized_denied_sensitivity_${id}`;
    const deniedRestrictedOpportunityId = `evidence_authorized_denied_restricted_${id}`;
    const profile = { provider: 'mock', model: 'mock-embedding', dimension: 2, profile: 'mock-profile', version: 'v1', normalization: 'l2' };

    await sql`insert into accounts (id, name) values (${accountId}, 'Authorized account')`;
    await sql`insert into personas (id, display_name, role) values (${userId}, 'Authorized user', 'seller')`;
    await sql`insert into opportunities (id, account_id, name, restricted) values (${opportunityId}, ${accountId}, 'Authorized opportunity', false), (${restrictedOpportunityId}, ${accountId}, 'Restricted opportunity', true)`;
    await sql`insert into permission_grants (id, persona_id, account_id, source_type, can_read, sensitive_pricing, can_read_restricted) values
      (${`grant_authorized_a_${id}`}, ${userId}, ${accountId}, 'crm', true, false, false),
      (${`grant_authorized_b_${id}`}, ${userId}, ${accountId}, 'crm', true, false, false)`;
    await sql`insert into document_versions (id, external_id, version, source_type, content_hash, content) values (${documentId}, ${documentId}, 1, 'crm', 'authorized document hash', 'search content')`;
    await sql`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, embedding, embedding_provider, embedding_model, embedding_dimension, embedding_profile, embedding_version, embedding_normalization) values
      (${firstId}, ${documentId}, ${accountId}, ${opportunityId}, 0, 'crm', 'internal', 'authorized-first', 'first', '[1,0]'::vector, 'mock', 'mock-embedding', 2, 'mock-profile', 'v1', 'l2'),
      (${secondId}, ${documentId}, ${accountId}, ${opportunityId}, 1, 'crm', 'internal', 'authorized-second', 'second', '[0.8,0.6]'::vector, 'mock', 'mock-embedding', 2, 'mock-profile', 'v1', 'l2'),
      (${thirdId}, ${documentId}, ${accountId}, ${opportunityId}, 2, 'crm', 'internal', 'authorized-third', 'third', '[0,1]'::vector, 'mock', 'mock-embedding', 2, 'mock-profile', 'v1', 'l2'),
      (${deniedSourceId}, ${documentId}, ${accountId}, ${opportunityId}, 3, 'slack', 'internal', 'authorized-denied-source', 'source denied', '[1,0]'::vector, 'mock', 'mock-embedding', 2, 'mock-profile', 'v1', 'l2'),
      (${deniedSensitivityId}, ${documentId}, ${accountId}, ${opportunityId}, 4, 'crm', 'restricted', 'authorized-denied-sensitivity', 'sensitivity denied', '[1,0]'::vector, 'mock', 'mock-embedding', 2, 'mock-profile', 'v1', 'l2'),
      (${deniedRestrictedOpportunityId}, ${documentId}, ${accountId}, ${restrictedOpportunityId}, 5, 'crm', 'internal', 'authorized-denied-restricted', 'restricted opportunity denied', '[1,0]'::vector, 'mock', 'mock-embedding', 2, 'mock-profile', 'v1', 'l2')`;

    const database = createDatabaseClient(databaseUrl, 1);
    const repository = new PostgresEvidenceRepository(database);
    const access = { personaId: userId as never, allowSensitivePricing: true };
    const allPublicMatches = await repository.searchExactCosine({ access, accountId: accountId as never, opportunityId: opportunityId as never, embedding: [1, 0], limit: 5, profile });
    const topTwoPublicMatches = await repository.searchExactCosine({ access, accountId: accountId as never, opportunityId: opportunityId as never, embedding: [1, 0], limit: 2, profile });
    const restrictedOpportunityMatches = await repository.searchExactCosine({ access, accountId: accountId as never, opportunityId: restrictedOpportunityId as never, embedding: [1, 0], limit: 5, profile });
    await database.close();

    expect(allPublicMatches.map((match) => match.evidenceId)).toEqual([firstId, secondId, thirdId]);
    expect(topTwoPublicMatches.map((match) => match.evidenceId)).toEqual([firstId, secondId]);
    expect(allPublicMatches.map((match) => match.evidenceId)).not.toContain(deniedSourceId);
    expect(allPublicMatches.map((match) => match.evidenceId)).not.toContain(deniedSensitivityId);
    expect(restrictedOpportunityMatches).toEqual([]);
  });

  it('atomically starts, reserves, settles, and rejects conflicting duplicate finalization', async () => {
    const sql = openDatabase();
    const id = crypto.randomUUID().replaceAll('-', '');
    const userId = `user_attempt_${id}`;
    const accountId = `account_attempt_${id}`;
    const opportunityId = `opportunity_attempt_${id}`;
    const runId = `run_attempt_${id}`;
    await sql`insert into personas (id, display_name, role) values (${userId}, 'Attempt user', 'seller')`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Attempt account')`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Attempt opportunity')`;
    await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, version) values (${runId}, ${opportunityId}, ${userId}, 'created', 'mock', 'mock-chat', 0)`;
    await sql`insert into run_budgets (run_id, max_calls, max_input_tokens, max_output_tokens) values (${runId}, 2, 20, 10)`;
    const database = createDatabaseClient(databaseUrl, 1);
    const ledger = new PostgresProviderAttemptLedger(database);
    const reservation = await ledger.beginAttempt({ runScope: runId, operation: 'specialist', provider: 'mock', model: 'mock-chat', inputTokens: 5, requestedOutputTokens: 8 });
    expect((await sql<{ status: string; reserved_output_tokens: number }[]>`select generation_attempts.status, run_budgets.reserved_output_tokens from generation_attempts join run_budgets on run_budgets.run_id = generation_attempts.run_id where generation_attempts.id = ${reservation.attemptId}`)[0]).toEqual({ status: 'attempt_started', reserved_output_tokens: 8 });
    await ledger.settleAttempt({ ...reservation, reservedInputTokens: 5, actualInputTokens: 7, actualOutputTokens: 12, requestId: 'provider-request', responseId: 'provider-response' });
    expect((await sql<{ status: string; possible_duplicate: boolean; input_tokens: number; output_tokens: number; used_input_tokens: number; used_output_tokens: number; reserved_output_tokens: number }[]>`select generation_attempts.status, generation_attempts.possible_duplicate, generation_attempts.input_tokens, generation_attempts.output_tokens, run_budgets.used_input_tokens, run_budgets.used_output_tokens, run_budgets.reserved_output_tokens from generation_attempts join run_budgets on run_budgets.run_id = generation_attempts.run_id where generation_attempts.id = ${reservation.attemptId}`)[0]).toEqual({ status: 'completed', possible_duplicate: false, input_tokens: 7, output_tokens: 12, used_input_tokens: 7, used_output_tokens: 12, reserved_output_tokens: 0 });
    await expect(ledger.beginAttempt({ runScope: runId, operation: 'exhausted', provider: 'mock', model: 'mock-chat', inputTokens: 1, requestedOutputTokens: 1 })).rejects.toThrow('output budget');
    await ledger.settleAttempt({ ...reservation, reservedInputTokens: 5, actualInputTokens: 7, actualOutputTokens: 12, requestId: 'provider-request', responseId: 'provider-response' });
    await expect(ledger.settleAttempt({ ...reservation, reservedInputTokens: 5, actualInputTokens: 7, actualOutputTokens: 8, requestId: 'provider-request', responseId: 'provider-response' })).rejects.toBeInstanceOf(ProviderAttemptFinalizationConflict);
    await database.close();
  });

  it('restarts a generic gateway with the same local sequence and uses the database ordinal', async () => {
    const sql = openDatabase(); const id = crypto.randomUUID().replaceAll('-', '');
    const userId = `user_restart_${id}`; const accountId = `account_restart_${id}`; const opportunityId = `opportunity_restart_${id}`; const runId = `run_restart_${id}`;
    await sql`insert into personas (id, display_name, role) values (${userId}, 'Restart user', 'seller')`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Restart account')`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Restart opportunity')`;
    await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, version) values (${runId}, ${opportunityId}, ${userId}, 'created', 'mock', 'mock-chat', 0)`;
    await sql`insert into run_budgets (run_id, max_calls, max_input_tokens, max_output_tokens) values (${runId}, 2, 1_000, 200)`;
    const database = createDatabaseClient(databaseUrl, 1);
    const transport: ModelTransport = { capabilities: { nativeStructuredOutput: false }, async generate() { return { text: '{"items":[]}', usage: { inputTokens: 1, outputTokens: 1 } }; } };
    const request = {
      schema: z.object({ items: z.array(z.string()) }).strict(), messages: [{ role: 'user' as const, content: 'Return items.' }], operation: 'restarted-specialist',
      durableAttempt: { runScope: runId, provider: 'mock', model: 'mock-chat' },
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 1_000, maxOutputTokens: 200 }
    };
    await createBudgetedModelGateway(transport, undefined, new PostgresProviderAttemptLedger(database)).generateObject(request);
    await createBudgetedModelGateway(transport, undefined, new PostgresProviderAttemptLedger(database)).generateObject(request);
    expect(await sql<{ ordinal: number }[]>`select ordinal from run_budget_reservations where run_id = ${runId} and operation = 'restarted-specialist' order by ordinal`).toEqual([{ ordinal: 1 }, { ordinal: 2 }]);
    await database.close();
  });

  it('serializes durable reservations and reconciles an abandoned call as a possible duplicate', async () => {
    const sql = openDatabase(); const id = crypto.randomUUID().replaceAll('-', '');
    const userId = `user_budget_${id}`; const accountId = `account_budget_${id}`; const opportunityId = `opportunity_budget_${id}`; const runId = `run_budget_${id}`;
    await sql`insert into personas (id, display_name, role) values (${userId}, 'Budget user', 'seller')`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Budget account')`;
    await sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Budget opportunity')`;
    await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version) values (${runId}, ${opportunityId}, ${userId}, 'created', 'mock', 'mock-chat', ${'a'.repeat(64)}, 0)`;
    await sql`insert into run_budgets (run_id, max_calls, max_input_tokens, max_output_tokens) values (${runId}, 3, 9, 20)`;
    const infoLog = vi.spyOn(logger, 'info');
    const errorLog = vi.spyOn(logger, 'error');
    const firstDatabase = createDatabaseClient(databaseUrl, 1); const secondDatabase = createDatabaseClient(databaseUrl, 1);
    const first = new PostgresProviderAttemptLedger(firstDatabase);
    const second = new PostgresProviderAttemptLedger(secondDatabase);
    const results = await Promise.allSettled([
      first.beginAttempt({ runScope: runId, operation: `specialist_a_${id}`, provider: 'mock', model: 'mock-chat', inputTokens: 5, requestedOutputTokens: 8 }),
      second.beginAttempt({ runScope: runId, operation: `specialist_b_${id}`, provider: 'mock', model: 'mock-chat', inputTokens: 5, requestedOutputTokens: 8 })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const reservation = results.find((result): result is PromiseFulfilledResult<{ reservationId: string; attemptId: string; grantedOutputTokens: number }> => result.status === 'fulfilled')?.value;
    if (reservation === undefined) throw new Error('Expected one reservation');
    const outstanding = (await sql<{ invocation_id: string | null; operation: string }[]>`select invocation_id, operation from run_budget_reservations where id = ${reservation.reservationId}`)[0];
    if (outstanding === undefined) throw new Error('Expected outstanding reservation');
    await second.beginAttempt({ runScope: runId, ...(outstanding.invocation_id === null ? {} : { invocationId: outstanding.invocation_id }), operation: outstanding.operation, provider: 'mock', model: 'mock-chat', inputTokens: 1, requestedOutputTokens: 1 });
    expect((await sql<{ status: string; possible_duplicate: boolean; actual_output_tokens: number }[]>`select run_budget_reservations.status, generation_attempts.possible_duplicate, run_budget_reservations.actual_output_tokens from run_budget_reservations join generation_attempts on generation_attempts.id = run_budget_reservations.attempt_id where run_budget_reservations.id = ${reservation.reservationId}`)[0]).toEqual({ status: 'possible_duplicate', possible_duplicate: true, actual_output_tokens: 8 });
    const started = infoLog.mock.calls.map(([payload]) => payload).filter((payload) => (
      payload !== null && typeof payload === 'object'
      && (payload as Record<string, unknown>).attemptId === reservation.attemptId
      && (payload as Record<string, unknown>).event === 'provider_attempt_started'
    ));
    const terminal = errorLog.mock.calls.map(([payload]) => payload).filter((payload) => (
      payload !== null && typeof payload === 'object'
      && (payload as Record<string, unknown>).attemptId === reservation.attemptId
      && (payload as Record<string, unknown>).event === 'provider_attempt_failed'
    ));
    expect(started).toHaveLength(1);
    expect(terminal).toEqual([expect.objectContaining({
      status: 'possible_duplicate',
      errorCode: 'ABANDONED_PROVIDER_ATTEMPT',
      provider: 'mock',
      model: 'mock-chat'
    })]);
    infoLog.mockRestore();
    errorLog.mockRestore();
    await firstDatabase.close();
    await secondDatabase.close();
  });
});
