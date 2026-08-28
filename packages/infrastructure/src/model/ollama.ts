import { APICallError, embedMany, generateText, jsonSchema, Output, type LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { z } from 'zod';
import {
  createBudgetedModelGateway,
  ModelGatewayTransportError,
  ModelRegistry,
  normalizeModelError,
  type ModelErrorCategory,
  type BudgetedModelGateway,
  type EmbeddingGateway,
  type ModelTransport,
  type ModelTransportRequest,
  type TransportGeneration
} from '@slacato/core';
import type { OllamaCapabilities, OllamaCapabilityProbe } from './capabilities.js';

export type OllamaGatewayConfig = Readonly<{
  baseURL: string;
  apiKey: string;
  generationModelId: string;
  embeddingModelId: string;
}>;

function warningText(warning: unknown): string {
  return typeof warning === 'object' && warning !== null && 'type' in warning && typeof warning.type === 'string'
    ? warning.type : 'provider_warning';
}

function categoryForApiCallError(error: InstanceType<typeof APICallError>): ModelErrorCategory {
  const status = error.statusCode;
  if (status === 401 || status === 403) return 'authorization';
  if (status === 429) return 'rate_limited';
  if (status !== undefined && status >= 400 && status < 500) return 'nonretryable_client';
  if (status !== undefined && status >= 500 && error.isRetryable) return 'server';
  if (status === undefined && error.isRetryable) return 'transient_transport';
  return 'unknown';
}

/** Converts SDK/provider structured errors to the provider-neutral core contract. */
export function normalizeOllamaTransportError(error: unknown): ModelGatewayTransportError {
  if (error instanceof ModelGatewayTransportError) return error;
  const generic = normalizeModelError(error).normalized;
  const apiError = APICallError.isInstance(error) ? error : undefined;
  const category = apiError === undefined ? generic.category : categoryForApiCallError(apiError);
  return new ModelGatewayTransportError({
    category,
    ...(generic.statusCode === undefined ? {} : { statusCode: generic.statusCode }),
    diagnosticCode: apiError === undefined ? 'ollama_unknown_error' : 'ollama_api_error',
    message: 'Ollama provider request failed'
  });
}

class OllamaTransport implements ModelTransport {
  public constructor(
    private readonly model: LanguageModel,
    public readonly capabilities: Readonly<{ nativeStructuredOutput: boolean }>
  ) {}

  public async generate<Value>(request: ModelTransportRequest<Value>): Promise<TransportGeneration<Value>> {
    const timeout = Math.max(1, request.deadlineAt - Date.now());
    const common = {
      model: this.model,
      messages: request.messages.map(({ role, content }) => ({ role, content })),
      allowSystemInMessages: true,
      maxRetries: 0,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: AbortSignal.timeout(timeout)
    };
    try {
      if (request.outputMode === 'native_schema') {
        if (request.schema === undefined) throw new Error('Native structured generation requires a schema');
        const inputJsonSchema = z.toJSONSchema(request.schema, { io: 'input' }) as unknown as Parameters<typeof jsonSchema>[0];
        const result = await generateText({
          ...common,
          output: Output.object({ schema: jsonSchema(inputJsonSchema) })
        });
        return {
          text: result.text,
          output: result.output as Value,
          usage: result.usage,
          warnings: (result.warnings ?? []).map(warningText)
        };
      }
      const result = await generateText(common);
      return { text: result.text, usage: result.usage, warnings: (result.warnings ?? []).map(warningText) };
    } catch (error) {
      throw normalizeOllamaTransportError(error);
    }
  }
}

function createProvider(config: OllamaGatewayConfig) {
  return createOllama({
    baseURL: config.baseURL,
    headers: { Authorization: `Bearer ${config.apiKey}` }
  });
}

/** Creates the private Ollama adapter behind provider-neutral core ports. */
export function createOllamaModelGateways(config: OllamaGatewayConfig, capabilities: Pick<OllamaCapabilities, 'nativeStructuredOutput'>): Readonly<{
  modelGateway: BudgetedModelGateway;
  embeddingGateway: EmbeddingGateway;
  registry: ModelRegistry;
}> {
  const provider = createProvider(config);
  const registry = new ModelRegistry();
  const languageModel = { providerId: 'ollama', modelId: config.generationModelId, nativeStructuredOutput: capabilities.nativeStructuredOutput };
  registry.register('brief', languageModel);
  registry.register('specialist', languageModel);
  registry.register('compaction', languageModel);
  registry.register('embedding', { providerId: 'ollama', modelId: config.embeddingModelId });
  return {
    modelGateway: createBudgetedModelGateway(new OllamaTransport(provider(config.generationModelId), capabilities)),
    embeddingGateway: {
      async embed(values: readonly string[]): Promise<number[][]> {
        if (values.length === 0) return [];
        try {
          const result = await embedMany({ model: provider.embedding(config.embeddingModelId), values: [...values], maxRetries: 0 });
          return result.embeddings.map((embedding) => [...embedding]);
        } catch (error) {
          throw normalizeOllamaTransportError(error);
        }
      }
    },
    registry
  };
}

async function listModelIds(config: OllamaGatewayConfig): Promise<readonly string[]> {
  try {
    const response = await fetch(`${config.baseURL.replace(/\/$/, '')}/tags`, {
      headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw { statusCode: response.status };
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || !('models' in payload) || !Array.isArray(payload.models)) {
      throw new Error('Ollama model discovery returned an invalid response');
    }
    return payload.models.flatMap((model) => typeof model === 'object' && model !== null && 'name' in model && typeof model.name === 'string' ? [model.name] : []);
  } catch (error) {
    throw normalizeOllamaTransportError(error);
  }
}

function isUnitNormalized(vector: readonly number[]): boolean {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return Math.abs(magnitude - 1) < 0.001;
}

/**
 * Credentialed capability probe. It is intentionally separate from run budgets
 * and reports only observed facts; callers must persist its result before using
 * native output mode or assuming embedding properties.
 */
export async function probeOllamaCapabilities(config: OllamaGatewayConfig): Promise<OllamaCapabilityProbe> {
  const provider = createProvider(config);
  const availableModelIds = await listModelIds(config);
  const model = provider(config.generationModelId);
  let nativeStructuredOutput = false;
  const warnings: string[] = [];
  try {
    const result = await generateText({
      model,
      prompt: 'Return the requested object.',
      output: Output.object({ schema: z.object({ ready: z.literal(true) }) }),
      maxRetries: 0,
      maxOutputTokens: 32,
      abortSignal: AbortSignal.timeout(15_000)
    });
    nativeStructuredOutput = result.output.ready === true;
    warnings.push(...(result.warnings ?? []).map(warningText));
  } catch (error) {
    warnings.push(`native_schema_probe_failed:${normalizeOllamaTransportError(error).category}`);
  }
  let embedding;
  try {
    embedding = await embedMany({
      model: provider.embedding(config.embeddingModelId),
      values: ['SlaCato capability probe'],
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw normalizeOllamaTransportError(error);
  }
  const vector = embedding.embeddings[0];
  if (vector === undefined || vector.length === 0) throw new Error('Ollama embedding probe returned no vector');
  warnings.push(...embedding.warnings.map(warningText));
  return {
    generationModelId: config.generationModelId,
    embeddingModelId: config.embeddingModelId,
    availableModelIds,
    nativeStructuredOutput,
    embeddingDimension: vector.length,
    embeddingUnitNormalized: isUnitNormalized(vector),
    warnings
  };
}
