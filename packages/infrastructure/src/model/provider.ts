import type { Env } from '../config/env.js';
import type { BudgetedModelGateway, EmbeddingGateway, GenerateObjectRequest, GenerationResult, ModelRegistry, RunBudgetLimits } from '@slacato/core';
import type { DatabaseClient } from '../db/client.js';
import { PostgresProviderAttemptLedger } from '../db/repositories/provider-attempt-ledger.js';
import { createMockModelGateways, MOCK_EMBEDDING_PROFILE, type MockModelGatewayOptions } from './mock.js';
import { createOllamaModelGateways } from './ollama.js';
import type { OllamaCapabilities } from './capabilities.js';

export type ConfiguredModelGateways = Readonly<{
  provider: 'mock' | 'ollama';
  modelGateway: BudgetedModelGateway;
  embeddingGateway: EmbeddingGateway;
  registry: ModelRegistry;
  embeddingProfile?: typeof MOCK_EMBEDDING_PROFILE;
  /** Verifies the workflow-created durable budget before returning a scoped gateway. */
  startRun(input: ProviderRunScope): Promise<RunScopedModelGateway>;
}>;

export type ProviderRunScope = Readonly<{ runScope: string; invocationId?: string; budget: RunBudgetLimits }>;
export type RunScopedModelGateway = Readonly<{
  modelGateway: Readonly<{ generateObject<Value>(request: Omit<GenerateObjectRequest<Value>, 'durableAttempt'>): Promise<GenerationResult<Value>> }>;
}>;

export type MockCompositionOptions = Readonly<{ database: DatabaseClient; mock: Omit<MockModelGatewayOptions, 'attemptLedger'>; ollamaCapabilities?: never }>;
export type OllamaCompositionOptions = Readonly<{ database: DatabaseClient; mock?: undefined; ollamaCapabilities?: Pick<OllamaCapabilities, 'nativeStructuredOutput'> }>;

/**
 * Selects the configured infrastructure adapter at composition time. Ollama
 * starts in prompted-JSON mode until its separate live capability gate proves
 * native structured output; mock selection never represents live compatibility.
 */
export function createConfiguredModelGateways(environment: Env & Readonly<{ AI_PROVIDER: 'mock' }>, options: MockCompositionOptions): ConfiguredModelGateways;
export function createConfiguredModelGateways(environment: Env & Readonly<{ AI_PROVIDER: 'ollama' }>, options: OllamaCompositionOptions): ConfiguredModelGateways;
export function createConfiguredModelGateways(
  environment: Env,
  options: MockCompositionOptions | OllamaCompositionOptions
): ConfiguredModelGateways {
  const runScoped = (gateway: BudgetedModelGateway, attemptLedger: PostgresProviderAttemptLedger, provider: 'mock' | 'ollama', model: string) => async (input: ProviderRunScope): Promise<RunScopedModelGateway> => {
    if (input.budget.scope !== input.runScope) throw new Error('Run budget scope must match the gateway run scope');
    await attemptLedger.assertRunBudget(input.budget);
    return { modelGateway: {
      generateObject<Value>(request: Omit<GenerateObjectRequest<Value>, 'durableAttempt'>) {
        return gateway.generateObject({ ...request, durableAttempt: { runScope: input.runScope, ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }), provider, model } });
      }
    } };
  };
  if (environment.AI_PROVIDER === 'mock') {
    if (!('mock' in options) || options.mock === undefined || typeof options.mock.resolve !== 'function') {
      throw new Error('Mock composition requires a mock fixture resolver');
    }
    if (options.database === undefined) throw new Error('Configured model composition requires a database client');
    const attemptLedger = new PostgresProviderAttemptLedger(options.database);
    const mock = createMockModelGateways({ ...options.mock, attemptLedger });
    return { provider: 'mock', ...mock, startRun: runScoped(mock.modelGateway, attemptLedger, 'mock', 'mock-specialist') };
  }
  if (options.database === undefined) throw new Error('Configured model composition requires a database client');
  if ('mock' in options && options.mock !== undefined) throw new Error('Ollama composition does not accept a mock fixture resolver');
  const attemptLedger = new PostgresProviderAttemptLedger(options.database);
  const ollama = createOllamaModelGateways({
    baseURL: environment.OLLAMA_BASE_URL,
    apiKey: environment.OLLAMA_API_KEY,
    generationModelId: environment.OLLAMA_CHAT_MODEL,
    embeddingModelId: environment.OLLAMA_EMBEDDING_MODEL,
    attemptLedger
  }, options.ollamaCapabilities ?? { nativeStructuredOutput: false });
  return { provider: 'ollama', ...ollama, startRun: runScoped(ollama.modelGateway, attemptLedger, 'ollama', environment.OLLAMA_CHAT_MODEL) };
}
