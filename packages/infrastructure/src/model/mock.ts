import {
  createBudgetedModelGateway,
  ModelRegistry,
  type BudgetedModelGateway,
  type EmbeddingGateway,
  type ModelTransport,
  type ModelTransportRequest,
  type TransportGeneration
} from '@slacato/core';

/** Fixed development/demo profile; it is not an assertion about a live model. */
export const MOCK_EMBEDDING_DIMENSION = 64;

/** Identifies vectors so persistence can reject mixed profiles before comparison. */
export const MOCK_EMBEDDING_PROFILE = Object.freeze({
  providerId: 'mock', modelId: 'mock-embedding', dimension: MOCK_EMBEDDING_DIMENSION, unitNormalized: true
});

/**
 * Injects deterministic generic responses without teaching infrastructure about
 * agent schemas. Responses still traverse the public budgeted gateway.
 */
export type MockGenerationResolver = <Value>(request: ModelTransportRequest<Value>) => Promise<TransportGeneration<Value>> | TransportGeneration<Value>;

/** Construction options for the deterministic development/demo provider. */
export type MockModelGatewayOptions = Readonly<{ resolve?: MockGenerationResolver }>;

class MockTransport implements ModelTransport {
  public readonly capabilities = { nativeStructuredOutput: false } as const;

  public constructor(private readonly resolve: MockGenerationResolver) {}

  public async generate<Value>(request: ModelTransportRequest<Value>): Promise<TransportGeneration<Value>> {
    const response = await this.resolve(request);
    return { ...response, warnings: [...(response.warnings ?? []), 'mock_provider'] };
  }
}

function defaultResponse<Value>(): TransportGeneration<Value> {
  return { text: '{}', usage: { inputTokens: 0, outputTokens: 1 } };
}

function tokenHash(token: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function embeddingFor(value: string): number[] {
  const vector = Array<number>(MOCK_EMBEDDING_DIMENSION).fill(0);
  const tokens = value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const token of tokens) {
    const hash = tokenHash(token);
    vector[hash % MOCK_EMBEDDING_DIMENSION]! += (hash & 0x80000000) === 0 ? 1 : -1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, entry) => sum + entry * entry, 0));
  return magnitude === 0 ? vector : vector.map((entry) => entry / magnitude);
}

/**
 * Creates a deterministic non-network provider for development and demos.
 * Its output is intentionally generic; callers script it through `resolve`.
 */
export function createMockModelGateways(options: MockModelGatewayOptions = {}): Readonly<{
  modelGateway: BudgetedModelGateway;
  embeddingGateway: EmbeddingGateway;
  registry: ModelRegistry;
  embeddingProfile: typeof MOCK_EMBEDDING_PROFILE;
}> {
  const registry = new ModelRegistry();
  registry.register('brief', { providerId: 'mock', modelId: 'mock-brief', nativeStructuredOutput: false });
  registry.register('specialist', { providerId: 'mock', modelId: 'mock-specialist', nativeStructuredOutput: false });
  registry.register('compaction', { providerId: 'mock', modelId: 'mock-compaction', nativeStructuredOutput: false });
  registry.register('embedding', { providerId: 'mock', modelId: MOCK_EMBEDDING_PROFILE.modelId });
  return {
    modelGateway: createBudgetedModelGateway(new MockTransport(options.resolve ?? defaultResponse)),
    embeddingGateway: { async embed(values: readonly string[]): Promise<number[][]> { return values.map(embeddingFor); } },
    registry,
    embeddingProfile: MOCK_EMBEDDING_PROFILE
  };
}
