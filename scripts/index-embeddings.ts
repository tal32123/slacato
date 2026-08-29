import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EmbeddingGateway,
  EmbeddingProfile,
  ProviderAttemptLedger
} from '../packages/core/src/index.js';
import {
  createDatabaseClient,
  createMockModelGateways,
  createOllamaModelGateways,
  createOpenRouterModelGateways,
  EmbeddingIndexer,
  probeOllamaCapabilities
} from '../packages/infrastructure/src/index.js';

const DEFAULT_DATABASE_URL = 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const DEFAULT_OLLAMA_BASE_URL = 'https://ollama.com/api';
const DEFAULT_OPENROUTER_CHAT_MODEL = 'openai/gpt-5.6-luna';
const DEFAULT_OPENROUTER_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const DEFAULT_OPENROUTER_EMBEDDING_DIMENSION = 1536;
const MAX_OPENROUTER_EMBEDDING_DIMENSION = 16_000;
const unusedGenerationLedger: ProviderAttemptLedger = {
  async beginAttempt() {
    throw new Error('Generation is unavailable in the embedding index command');
  },
  async settleAttempt() {},
  async releaseAttempt() {}
};

type IndexEnvironment = Readonly<Record<string, string | undefined>>;
type ResolvedEmbeddingIndexConfiguration = Readonly<{
  gateway: EmbeddingGateway;
  profile: EmbeddingProfile;
}>;

/** Resolves and validates the configured OpenRouter embedding dimension. */
function openRouterEmbeddingDimension(environment: IndexEnvironment, model: string): number {
  const configured = environment.OPENROUTER_EMBEDDING_DIMENSION;
  if (configured === undefined) {
    if (model === DEFAULT_OPENROUTER_EMBEDDING_MODEL) return DEFAULT_OPENROUTER_EMBEDDING_DIMENSION;
    throw new Error('Custom OpenRouter embedding models require OPENROUTER_EMBEDDING_DIMENSION');
  }
  const dimension = Number(configured);
  if (
    !Number.isInteger(dimension) ||
    dimension <= 0 ||
    dimension > MAX_OPENROUTER_EMBEDDING_DIMENSION
  ) {
    throw new Error(
      `OPENROUTER_EMBEDDING_DIMENSION must be an integer between 1 and ${MAX_OPENROUTER_EMBEDDING_DIMENSION}`
    );
  }
  if (
    model === DEFAULT_OPENROUTER_EMBEDDING_MODEL &&
    dimension !== DEFAULT_OPENROUTER_EMBEDDING_DIMENSION
  ) {
    throw new Error(
      `The default OpenRouter embedding model requires dimension ${DEFAULT_OPENROUTER_EMBEDDING_DIMENSION}`
    );
  }
  return dimension;
}

/** Builds the persistent embedding profile name for an OpenRouter model and dimension. */
function openRouterProfileName(model: string, dimension: number): string {
  return `openrouter-${model.replaceAll(/[^a-zA-Z0-9]+/g, '-')}-${dimension}`;
}
/** Probes Ollama through its existing adapter and derives the profile from observed embedding properties. */
async function resolveOllamaEmbeddingIndexConfiguration(
  environment: IndexEnvironment
): Promise<ResolvedEmbeddingIndexConfiguration> {
  const apiKey = environment.OLLAMA_API_KEY;
  const generationModelId = environment.OLLAMA_CHAT_MODEL;
  const embeddingModelId = environment.OLLAMA_EMBEDDING_MODEL;
  if (apiKey === undefined || apiKey.trim().length === 0)
    throw new Error('Ollama embedding indexing requires OLLAMA_API_KEY');
  if (generationModelId === undefined || generationModelId.trim().length === 0)
    throw new Error('Ollama embedding indexing requires OLLAMA_CHAT_MODEL');
  if (embeddingModelId === undefined || embeddingModelId.trim().length === 0)
    throw new Error('Ollama embedding indexing requires OLLAMA_EMBEDDING_MODEL');
  const config = {
    baseURL: environment.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
    apiKey,
    generationModelId,
    embeddingModelId,
    attemptLedger: unusedGenerationLedger
  };
  const capabilities = await probeOllamaCapabilities(config);
  const ollama = createOllamaModelGateways(config, capabilities);
  const embeddingModel = ollama.registry.resolve('embedding');
  const normalization = capabilities.embeddingUnitNormalized ? 'l2' : 'none';
  return {
    gateway: ollama.embeddingGateway,
    profile: {
      provider: embeddingModel.providerId,
      model: capabilities.embeddingModelId,
      dimension: capabilities.embeddingDimension,
      profile: `ollama-${capabilities.embeddingModelId.replaceAll(/[^a-zA-Z0-9]+/g, '-')}-${capabilities.embeddingDimension}-${normalization}`,
      version: 'v1',
      normalization
    }
  };
}

/** Composes the configured provider's embedding gateway with compatible, truthful profile metadata. */
export function resolveEmbeddingIndexConfiguration(
  environment: IndexEnvironment & Readonly<{ AI_PROVIDER: 'ollama' }>
): Promise<ResolvedEmbeddingIndexConfiguration>;
export function resolveEmbeddingIndexConfiguration(
  environment: IndexEnvironment & Readonly<{ AI_PROVIDER?: 'mock' | 'openrouter' }>
): ResolvedEmbeddingIndexConfiguration;
export function resolveEmbeddingIndexConfiguration(
  environment: IndexEnvironment
): ResolvedEmbeddingIndexConfiguration | Promise<ResolvedEmbeddingIndexConfiguration>;
export function resolveEmbeddingIndexConfiguration(
  environment: IndexEnvironment
): ResolvedEmbeddingIndexConfiguration | Promise<ResolvedEmbeddingIndexConfiguration> {
  const provider = environment.AI_PROVIDER ?? 'mock';
  if (provider === 'mock') {
    const mock = createMockModelGateways({
      resolve: () => ({ text: '{}' }),
      attemptLedger: unusedGenerationLedger
    });
    return {
      gateway: mock.embeddingGateway,
      profile: {
        provider: mock.embeddingProfile.providerId,
        model: mock.embeddingProfile.modelId,
        dimension: mock.embeddingProfile.dimension,
        profile: 'mock-token-hash-64',
        version: 'v1',
        normalization: 'l2'
      }
    };
  }
  if (provider === 'ollama') return resolveOllamaEmbeddingIndexConfiguration(environment);
  if (provider !== 'openrouter')
    throw new Error(`Unsupported AI_PROVIDER for embedding indexing: ${provider}`);
  const apiKey = environment.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0)
    throw new Error('OpenRouter embedding indexing requires OPENROUTER_API_KEY');
  const embeddingModelId =
    environment.OPENROUTER_EMBEDDING_MODEL ?? DEFAULT_OPENROUTER_EMBEDDING_MODEL;
  const dimension = openRouterEmbeddingDimension(environment, embeddingModelId);
  const openrouter = createOpenRouterModelGateways({
    apiKey,
    generationModelId: environment.OPENROUTER_CHAT_MODEL ?? DEFAULT_OPENROUTER_CHAT_MODEL,
    embeddingModelId,
    attemptLedger: unusedGenerationLedger
  });
  return {
    gateway: openrouter.embeddingGateway,
    profile: {
      provider: 'openrouter',
      model: embeddingModelId,
      dimension,
      profile: openRouterProfileName(embeddingModelId, dimension),
      version: 'v1',
      normalization: 'l2'
    }
  };
}

/** Runs the official canonical-corpus embedding index command. */
export async function indexEmbeddings(
  input: Readonly<{ databaseUrl: string; batchSize?: number }>
): Promise<Readonly<{ indexed: number; skipped: number; batches: number }>> {
  const configuration = await resolveEmbeddingIndexConfiguration(process.env);
  const database = createDatabaseClient(input.databaseUrl, 2);
  try {
    return await new EmbeddingIndexer(database, configuration.gateway, configuration.profile, {
      batchSize: input.batchSize,
      corpus: {
        sourceLocatorPrefixes: ['salesforce/', 'gong/', 'pricing/', 'slack/', 'policies/'],
        requireCompleteProvenance: true
      }
    }).index();
  } finally {
    await database.close();
  }
}

/** Runs the embedding-index CLI and prints the indexing result. */
async function main(): Promise<void> {
  const result = await indexEmbeddings({
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
