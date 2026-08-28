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

/**
 * Selects the configured infrastructure adapter at composition time. Ollama
 * starts in prompted-JSON mode until its separate live capability gate proves
 * native structured output; mock selection never represents live compatibility.
 */
export function createConfiguredModelGateways(
  environment: Env,
  options: Readonly<{ mock?: MockModelGatewayOptions; ollamaCapabilities?: Pick<OllamaCapabilities, 'nativeStructuredOutput'> }> = {}
): ConfiguredModelGateways {
  if (environment.AI_PROVIDER === 'mock') {
    const mock = createMockModelGateways(options.mock);
    return { provider: 'mock', ...mock };
  }
  const ollama = createOllamaModelGateways({
    baseURL: environment.OLLAMA_BASE_URL,
    apiKey: environment.OLLAMA_API_KEY,
    generationModelId: environment.OLLAMA_CHAT_MODEL,
    embeddingModelId: environment.OLLAMA_EMBEDDING_MODEL
  }, options.ollamaCapabilities ?? { nativeStructuredOutput: false });
  return { provider: 'ollama', ...ollama };
}
