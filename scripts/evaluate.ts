import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { z } from 'zod';
import type { AuthorizedSourceType, EmbeddingProfile, ProviderAttemptLedger } from '../packages/core/src/index.js';
import { AUTHORIZED_SOURCE_TYPES } from '../packages/core/src/index.js';
import { EmbeddingIndexer, PostgresHybridEvidenceRetriever, createDatabaseClient, createMockModelGateways } from '../packages/infrastructure/src/index.js';
import { ingestFixtureRecords } from './ingest.js';

const DEFAULT_DATABASE_URL = 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const caseSchema = z.object({
  id: z.string().min(1), userId: z.string().min(1), accountId: z.string().min(1), opportunityId: z.string().min(1),
  query: z.string().min(1), limit: z.number().int().min(1).max(20), relevantEvidenceIds: z.array(z.string().min(1)), expectedDenied: z.boolean().optional()
}).strict();
const goldenSchema = z.object({ version: z.literal(1), cases: z.array(caseSchema).min(1) }).strict();

export type RetrievalEvaluationInput = Readonly<{
  id: string; k: number; relevantEvidenceIds: readonly string[]; retrievedEvidenceIds: readonly string[]; denied: boolean;
}>;

export function evaluateRetrievalResults(inputs: readonly RetrievalEvaluationInput[]) {
  const cases = inputs.map((input) => {
    const relevant = new Set(input.relevantEvidenceIds);
    const retrieved = [...new Set(input.retrievedEvidenceIds)].slice(0, input.k);
    const hits = retrieved.filter((id) => relevant.has(id)).length;
    const precisionAtK = relevant.size === 0 && retrieved.length === 0 ? 1 : hits / input.k;
    const recallAtK = relevant.size === 0 ? 1 : hits / relevant.size;
    return {
      id: input.id, precisionAtK, recallAtK, leakedEvidence: input.denied ? retrieved.length : 0,
      retrieved: retrieved.length,
      relevantEvidenceIds: [...relevant], retrievedEvidenceIds: retrieved
    };
  });
  const qualityCases = cases.filter((_, index) => !inputs[index]!.denied);
  const divisor = Math.max(1, qualityCases.length);
  return {
    cases,
    summary: {
      macroPrecisionAtK: qualityCases.reduce((sum, entry) => sum + entry.precisionAtK, 0) / divisor,
      macroRecallAtK: qualityCases.reduce((sum, entry) => sum + entry.recallAtK, 0) / divisor,
      permissionLeakage: cases.reduce((sum, entry) => sum + entry.leakedEvidence, 0)
    }
  };
}

const unusedGenerationLedger: ProviderAttemptLedger = {
  async beginAttempt() { throw new Error('Generation is unavailable during deterministic retrieval evaluation'); },
  async settleAttempt() {}, async releaseAttempt() {}
};

async function runRetrievalEvaluation(): Promise<ReturnType<typeof evaluateRetrievalResults>> {
  const golden = goldenSchema.parse(JSON.parse(await readFile(resolve('evals/golden-retrieval.json'), 'utf8')));
  const baseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const databaseName = `slacato_eval_${randomUUID().replaceAll('-', '')}`;
  const evaluationUrl = new URL(baseUrl);
  evaluationUrl.pathname = `/${databaseName}`;
  const admin = postgres(baseUrl, { max: 1 });
  let database: ReturnType<typeof createDatabaseClient> | undefined;
  try {
    await admin.unsafe(`create database "${databaseName}"`);
    database = createDatabaseClient(evaluationUrl.toString(), 4);
    await migrate(drizzle(database.sql), { migrationsFolder: resolve('drizzle') });
    await ingestFixtureRecords({ root: resolve('fixtures/cato'), databaseUrl: evaluationUrl.toString() });
    const mock = createMockModelGateways({ resolve: () => ({ text: '{}' }), attemptLedger: unusedGenerationLedger });
    const profile: EmbeddingProfile = { provider: mock.embeddingProfile.providerId, model: mock.embeddingProfile.modelId, dimension: mock.embeddingProfile.dimension, profile: 'mock-token-hash-64', version: 'v1', normalization: 'l2' };
    await new EmbeddingIndexer(database, mock.embeddingGateway, profile).index();
    const retriever = new PostgresHybridEvidenceRetriever(database, mock.embeddingGateway, profile, () => new Date('2026-08-28T00:00:00.000Z'));
    const results: RetrievalEvaluationInput[] = [];
    for (const testCase of golden.cases) {
      const opportunity = await database.sql<{ restricted: boolean }[]>`select restricted from opportunities where id = ${testCase.opportunityId} and account_id = ${testCase.accountId}`;
      const grants = await database.sql<{ source_type: string; can_read_restricted: boolean; sensitive_pricing: boolean; can_request_approval: boolean; can_approve: boolean }[]>`
        select source_type, can_read_restricted, sensitive_pricing, can_request_approval, can_approve from permission_grants
        where persona_id = ${testCase.userId} and account_id = ${testCase.accountId} and can_read = true order by source_type`;
      const denied = grants.length === 0 || (opportunity[0]?.restricted === true && !grants.some((grant) => grant.can_read_restricted));
      const sourceTypes = denied ? [...AUTHORIZED_SOURCE_TYPES] : [...new Set(grants.map((grant) => grant.source_type).filter((source): source is AuthorizedSourceType => AUTHORIZED_SOURCE_TYPES.includes(source as AuthorizedSourceType)))].sort();
      const runId = `run_eval_${testCase.id.replaceAll(/[^A-Za-z0-9_-]/g, '_')}`;
      await database.sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model) values (${runId}, ${testCase.opportunityId}, ${testCase.userId}, 'retrieving', 'mock', 'mock-brief')`;
      const result = await retriever.search({
        query: testCase.query, accountId: testCase.accountId, opportunityId: testCase.opportunityId, runId, limit: testCase.limit, maxContextCharacters: 20_000,
        scope: { personaId: testCase.userId, allowed: true, accountIds: [testCase.accountId], sourceTypes, canViewSensitivePricing: grants.some((grant) => grant.sensitive_pricing), canRequestApproval: grants.some((grant) => grant.can_request_approval), canApprove: grants.some((grant) => grant.can_approve), canViewRestrictedAccounts: grants.some((grant) => grant.can_read_restricted) }
      });
      results.push({ id: testCase.id, k: testCase.limit, relevantEvidenceIds: testCase.relevantEvidenceIds, retrievedEvidenceIds: result.evidence.map((entry) => entry.evidenceId), denied: denied || testCase.expectedDenied === true });
    }
    return evaluateRetrievalResults(results);
  } finally {
    await database?.close();
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await admin.end({ timeout: 1 });
  }
}

async function main(): Promise<void> {
  if (process.argv[2] !== 'retrieval') throw new Error('Usage: pnpm tsx scripts/evaluate.ts retrieval');
  const report = await runRetrievalEvaluation();
  await mkdir(resolve('evals/reports'), { recursive: true });
  await writeFile(resolve('evals/reports/retrieval.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.summary.permissionLeakage !== 0 || report.summary.macroRecallAtK < 0.5) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
