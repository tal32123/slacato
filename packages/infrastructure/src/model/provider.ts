import type { Env } from '../config/env.js';
import type { BudgetedModelGateway, EmbeddingGateway, GenerateObjectRequest, GenerationResult, ModelRegistry, RunBudgetLimits } from '@slacato/core';
import { PostgresProviderAttemptLedger } from '../db/repositories/provider-attempt-ledger.js';
import { createMockModelGateways, MOCK_EMBEDDING_PROFILE, type MockModelGatewayOptions } from './mock.js';
import { createOllamaModelGateways } from './ollama.js';
import { createOpenRouterModelGateways } from './openrouter.js';
import type { OllamaCapabilities } from './capabilities.js';

export type ConfiguredModelGateways = Readonly<{
  provider: 'mock' | 'ollama' | 'openrouter';
  embeddingGateway: EmbeddingGateway;
  registry: ModelRegistry;
  embeddingProfile?: typeof MOCK_EMBEDDING_PROFILE;
  /** Verifies the workflow-created durable budget before returning a scoped gateway. */
  forRun(input: ProviderRunScope): Promise<RunScopedModelGateway>;
  /** Run-scoped embedding path sharing the same durable deadline and attempt ledger. */
  embeddingForRun(input: ProviderRunScope): Promise<EmbeddingGateway>;
}>;

export type ProviderRunScope = Readonly<{ runScope: string; invocationId?: string; logicalGenerationId?: string; budget: RunBudgetLimits }>;
export type RunScopedModelGateway = Readonly<{
  generateObject<Value>(request: Omit<GenerateObjectRequest<Value>, 'durableAttempt'>): Promise<GenerationResult<Value>>;
}>;

export type MockCompositionOptions = Readonly<{ attemptLedger: PostgresProviderAttemptLedger; mock: Omit<MockModelGatewayOptions, 'attemptLedger'>; ollamaCapabilities?: never }>;
export type OllamaCompositionOptions = Readonly<{ attemptLedger: PostgresProviderAttemptLedger; mock?: undefined; ollamaCapabilities?: Pick<OllamaCapabilities, 'nativeStructuredOutput'> }>;
export type OpenRouterCompositionOptions = Readonly<{ attemptLedger: PostgresProviderAttemptLedger; mock?: undefined; ollamaCapabilities?: never }>;

/** Selects the configured model provider while keeping every run within its durable budget and verified capabilities. */
export function createConfiguredModelGateways(environment: Env & Readonly<{ AI_PROVIDER: 'mock' }>, options: MockCompositionOptions): ConfiguredModelGateways;
export function createConfiguredModelGateways(environment: Env & Readonly<{ AI_PROVIDER: 'ollama' }>, options: OllamaCompositionOptions): ConfiguredModelGateways;
export function createConfiguredModelGateways(environment: Env & Readonly<{ AI_PROVIDER: 'openrouter' }>, options: OpenRouterCompositionOptions): ConfiguredModelGateways;
export function createConfiguredModelGateways(
  environment: Env,
  options: MockCompositionOptions | OllamaCompositionOptions | OpenRouterCompositionOptions
): ConfiguredModelGateways {
  const runScopedEmbedding = (gateway: EmbeddingGateway, attemptLedger: PostgresProviderAttemptLedger, provider: ConfiguredModelGateways['provider'], model: string) => async (input: ProviderRunScope): Promise<EmbeddingGateway> => {
    if (input.budget.scope !== input.runScope) throw new Error('Run budget scope must match the gateway run scope');
    await attemptLedger.assertRunBudget(input.budget);
    return { async embed(values: readonly string[]) {
      await attemptLedger.remainingDeadlineMs(input.runScope);
      const inputTokens = Math.max(1, Math.ceil(values.reduce((total, value) => total + value.length, 0) / 4));
      const reservation = await attemptLedger.beginAttempt({
        runScope: input.runScope, ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
        logicalGenerationId: input.logicalGenerationId ?? `embedding:${input.runScope}`, provider, model,
        operation: 'retrieval-embedding', inputTokens, requestedOutputTokens: 1
      });
      try {
        const output = await gateway.embed(values);
        await attemptLedger.remainingDeadlineMs(input.runScope);
        await attemptLedger.settleAttempt({ ...reservation, reservedInputTokens: inputTokens, actualInputTokens: inputTokens, actualOutputTokens: 1 });
        return output;
      } catch (error) {
        await attemptLedger.releaseAttempt({ ...reservation, disposition: 'possibly_sent', category: 'embedding_failure', diagnosticCode: 'retrieval_embedding_failed' });
        throw error;
      }
    } };
  };
  const runScoped = (gateway: BudgetedModelGateway, attemptLedger: PostgresProviderAttemptLedger, provider: ConfiguredModelGateways['provider'], model: string) => async (input: ProviderRunScope): Promise<RunScopedModelGateway> => {
    if (input.budget.scope !== input.runScope) throw new Error('Run budget scope must match the gateway run scope');
    await attemptLedger.assertRunBudget(input.budget);
    return { async generateObject<Value>(request: Omit<GenerateObjectRequest<Value>, 'durableAttempt'>) {
      const remainingDeadlineMs = await attemptLedger.remainingDeadlineMs(input.runScope);
      return gateway.generateObject({ ...request, limits: { ...request.limits, deadlineMs: Math.min(request.limits.deadlineMs, remainingDeadlineMs) },
        durableAttempt: { runScope: input.runScope, ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
          ...(input.logicalGenerationId === undefined ? {} : { logicalGenerationId: input.logicalGenerationId }), provider, model } });
    } };
  };
  if (environment.AI_PROVIDER === 'mock') {
    if (!('mock' in options) || options.mock === undefined || typeof options.mock.resolve !== 'function') {
      throw new Error('Mock composition requires a mock fixture resolver');
    }
    const attemptLedger = options.attemptLedger;
    const mock = createMockModelGateways({ ...options.mock, attemptLedger });
    return { provider: 'mock', embeddingGateway: mock.embeddingGateway, registry: mock.registry, embeddingProfile: mock.embeddingProfile,
      forRun: runScoped(mock.modelGateway, attemptLedger, 'mock', mock.registry.resolve('brief').modelId),
      embeddingForRun: runScopedEmbedding(mock.embeddingGateway, attemptLedger, 'mock', mock.registry.resolve('embedding').modelId) };
  }
  if (environment.AI_PROVIDER === 'openrouter') {
    if ('mock' in options && options.mock !== undefined) throw new Error('OpenRouter composition does not accept a mock fixture resolver');
    const attemptLedger = options.attemptLedger;
    const openrouter = createOpenRouterModelGateways({
      apiKey: environment.OPENROUTER_API_KEY,
      generationModelId: environment.OPENROUTER_CHAT_MODEL,
      embeddingModelId: environment.OPENROUTER_EMBEDDING_MODEL,
      attemptLedger
    });
    return { provider: 'openrouter', embeddingGateway: openrouter.embeddingGateway, registry: openrouter.registry,
      forRun: runScoped(openrouter.modelGateway, attemptLedger, 'openrouter', environment.OPENROUTER_CHAT_MODEL),
      embeddingForRun: runScopedEmbedding(openrouter.embeddingGateway, attemptLedger, 'openrouter', environment.OPENROUTER_EMBEDDING_MODEL) };
  }
  if ('mock' in options && options.mock !== undefined) throw new Error('Ollama composition does not accept a mock fixture resolver');
  const attemptLedger = options.attemptLedger;
  const ollama = createOllamaModelGateways({
    baseURL: environment.OLLAMA_BASE_URL,
    apiKey: environment.OLLAMA_API_KEY,
    generationModelId: environment.OLLAMA_CHAT_MODEL,
    embeddingModelId: environment.OLLAMA_EMBEDDING_MODEL,
    attemptLedger
  }, options.ollamaCapabilities ?? { nativeStructuredOutput: false });
  return { provider: 'ollama', embeddingGateway: ollama.embeddingGateway, registry: ollama.registry,
    forRun: runScoped(ollama.modelGateway, attemptLedger, 'ollama', environment.OLLAMA_CHAT_MODEL),
    embeddingForRun: runScopedEmbedding(ollama.embeddingGateway, attemptLedger, 'ollama', environment.OLLAMA_EMBEDDING_MODEL) };
}
