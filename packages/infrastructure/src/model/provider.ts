import type { Env } from '../config/env.js';
import type { BudgetedModelGateway, EmbeddingGateway, ModelRegistry } from '@slacato/core';
import { createMockModelGateways, MOCK_EMBEDDING_PROFILE, type MockModelGatewayOptions } from './mock.js';
import { createOllamaModelGateways } from './ollama.js';
import type { OllamaCapabilities } from './capabilities.js';

export type ConfiguredModelGateways = Readonly<{
  provider: 'mock' | 'ollama';
  modelGateway: BudgetedModelGateway;
  embeddingGateway: EmbeddingGateway;
  registry: ModelRegistry;
  embeddingProfile?: typeof MOCK_EMBEDDING_PROFILE;
}>;

export type MockCompositionOptions = Readonly<{ mock: MockModelGatewayOptions; ollamaCapabilities?: never }>;
export type OllamaCompositionOptions = Readonly<{ mock?: undefined; ollamaCapabilities?: Pick<OllamaCapabilities, 'nativeStructuredOutput'> }>;

/**
 * Selects the configured infrastructure adapter at composition time. Ollama
 * starts in prompted-JSON mode until its separate live capability gate proves
 * native structured output; mock selection never represents live compatibility.
 */
export function createConfiguredModelGateways(environment: Env & Readonly<{ AI_PROVIDER: 'mock' }>, options: MockCompositionOptions): ConfiguredModelGateways;
export function createConfiguredModelGateways(environment: Env & Readonly<{ AI_PROVIDER: 'ollama' }>, options?: OllamaCompositionOptions): ConfiguredModelGateways;
export function createConfiguredModelGateways(
  environment: Env,
  options: MockCompositionOptions | OllamaCompositionOptions = {}
): ConfiguredModelGateways {
  if (environment.AI_PROVIDER === 'mock') {
    if (!('mock' in options) || options.mock === undefined || typeof options.mock.resolve !== 'function') {
      throw new Error('Mock composition requires a mock fixture resolver');
    }
    const mock = createMockModelGateways(options.mock);
    return { provider: 'mock', ...mock };
  }
  if ('mock' in options && options.mock !== undefined) throw new Error('Ollama composition does not accept a mock fixture resolver');
  const ollama = createOllamaModelGateways({
    baseURL: environment.OLLAMA_BASE_URL,
    apiKey: environment.OLLAMA_API_KEY,
    generationModelId: environment.OLLAMA_CHAT_MODEL,
    embeddingModelId: environment.OLLAMA_EMBEDDING_MODEL
  }, options.ollamaCapabilities ?? { nativeStructuredOutput: false });
  return { provider: 'ollama', ...ollama };
}
