import type { Env } from '../config/env.js';
import type { PostgresProviderAttemptLedger } from '../db/repositories/provider-attempt-ledger.js';
import {
  type ConfiguredModelGateways,
  type ConfiguredProvider,
  type MockCompositionOptions,
  type OllamaCompositionOptions,
  type OpenRouterCompositionOptions,
  type ProviderCompositionOptions,
  type ProviderModels,
  type ProviderRuntimeFacts,
  resolveProviderDescriptor,
  type WorkerCompositionOverrides
} from './registry.js';

export type {
  AiProvider,
  ConfiguredModelGateways,
  ConfiguredProvider,
  MockCompositionOptions,
  OllamaCompositionOptions,
  OpenRouterCompositionOptions,
  ProviderCompositionOptions,
  ProviderModels,
  ProviderRunScope,
  ProviderRuntimeFacts,
  RunScopedModelGateway,
  WorkerCompositionOverrides
} from './registry.js';
export { PROVIDER_REGISTRY, type ProviderDescriptor } from './registry.js';

/** Selects the configured model provider while keeping every run within its durable budget and verified capabilities. */
export function createConfiguredModelGateways(
  environment: Env & Readonly<{ AI_PROVIDER: 'mock' }>,
  options: MockCompositionOptions
): ConfiguredModelGateways;
export function createConfiguredModelGateways(
  environment: Env & Readonly<{ AI_PROVIDER: 'ollama' }>,
  options: OllamaCompositionOptions
): ConfiguredModelGateways;
export function createConfiguredModelGateways(
  environment: Env & Readonly<{ AI_PROVIDER: 'openrouter' }>,
  options: OpenRouterCompositionOptions
): ConfiguredModelGateways;
export function createConfiguredModelGateways(
  environment: Env,
  options: ProviderCompositionOptions
): ConfiguredModelGateways {
  return resolveProviderDescriptor(environment).createGateways(environment, options);
}

/** Composes the configured provider's gateways from the worker's provider-specific overrides. */
export function createWorkerModelGateways(
  environment: Env,
  attemptLedger: PostgresProviderAttemptLedger,
  overrides: WorkerCompositionOverrides = {}
): ConfiguredModelGateways {
  const descriptor = resolveProviderDescriptor(environment);
  return descriptor.createGateways(
    environment,
    descriptor.workerCompositionOptions({ attemptLedger, overrides })
  );
}

/** Resolves the configured model names at the provider-selection composition boundary. */
export function resolveProviderModels(environment: Env): ProviderModels {
  return resolveProviderDescriptor(environment).models(environment);
}

/** Describes the provider runtime facts that diagnostics reports without reconstructing them. */
export function resolveProviderRuntimeFacts(environment: Env): ProviderRuntimeFacts {
  const descriptor = resolveProviderDescriptor(environment);
  const models = descriptor.models(environment);
  return {
    provider: environment.AI_PROVIDER,
    outputMode: descriptor.outputMode,
    pinnedGenerationModel: models.generation,
    pinnedEmbeddingModel: models.embedding
  };
}

/** Resolves the provider target, including any credentials, that readiness probes interrogate. */
export function resolveConfiguredProvider(environment: Env): ConfiguredProvider {
  const descriptor = resolveProviderDescriptor(environment);
  const models = descriptor.models(environment);
  return {
    provider: environment.AI_PROVIDER,
    generationModel: models.generation,
    embeddingModel: models.embedding,
    ...descriptor.readinessCredentials(environment)
  };
}
