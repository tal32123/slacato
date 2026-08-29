import { ModelRegistry, type ModelErrorCategory } from '@slacato/core';

/** Returns the provider warning type without exposing provider-specific warning details. */
export function warningText(warning: unknown): string {
  return typeof warning === 'object' && warning !== null && 'type' in warning && typeof warning.type === 'string'
    ? warning.type : 'provider_warning';
}

/** Classifies an API-call failure from its HTTP status and SDK retryability signal. */
export function classifyApiCallError(statusCode: number | undefined, isRetryable: boolean): ModelErrorCategory {
  if (statusCode === 401 || statusCode === 403) return 'authorization';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) return 'nonretryable_client';
  if (statusCode !== undefined && statusCode >= 500 && isRetryable) return 'server';
  if (statusCode === undefined && isRetryable) return 'transient_transport';
  return 'unknown';
}

/** Builds the standard generation and embedding model catalog for a provider adapter. */
export function createProviderModelRegistry(input: Readonly<{
  providerId: string;
  generationModelId: string;
  embeddingModelId: string;
  nativeStructuredOutput: boolean;
}>): ModelRegistry {
  const registry = new ModelRegistry();
  const languageModel = {
    providerId: input.providerId,
    modelId: input.generationModelId,
    nativeStructuredOutput: input.nativeStructuredOutput
  };
  registry.register('brief', languageModel);
  registry.register('specialist', languageModel);
  registry.register('compaction', languageModel);
  registry.register('embedding', { providerId: input.providerId, modelId: input.embeddingModelId });
  return registry;
}
