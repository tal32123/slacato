import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { EmbeddingProfile, ProviderAttemptLedger } from '../packages/core/src/index.js';
import { EmbeddingIndexer, createDatabaseClient, createMockModelGateways } from '../packages/infrastructure/src/index.js';

const DEFAULT_DATABASE_URL = 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const unusedGenerationLedger: ProviderAttemptLedger = {
  async beginAttempt() { throw new Error('Generation is unavailable in the embedding index command'); },
  async settleAttempt() {},
  async releaseAttempt() {}
};

export async function indexEmbeddings(input: Readonly<{ databaseUrl: string; batchSize?: number }>): Promise<Readonly<{ indexed: number; skipped: number; batches: number }>> {
  if ((process.env.AI_PROVIDER ?? 'mock') !== 'mock') {
    throw new Error('Ollama embedding activation requires the credentialed compatibility probe and an explicit embedding profile gate');
  }
  const mock = createMockModelGateways({ resolve: () => ({ text: '{}' }), attemptLedger: unusedGenerationLedger });
  const profile: EmbeddingProfile = {
    provider: mock.embeddingProfile.providerId,
    model: mock.embeddingProfile.modelId,
    dimension: mock.embeddingProfile.dimension,
    profile: 'mock-token-hash-64',
    version: 'v1',
    normalization: 'l2'
  };
  const database = createDatabaseClient(input.databaseUrl, 2);
  try {
    return await new EmbeddingIndexer(database, mock.embeddingGateway, profile, {
      batchSize: input.batchSize,
      corpus: { sourceLocatorPrefixes: ['salesforce/', 'gong/', 'pricing/', 'slack/', 'policies/'], requireCompleteProvenance: true }
    }).index();
  } finally {
    await database.close();
  }
}

async function main(): Promise<void> {
  const result = await indexEmbeddings({ databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
