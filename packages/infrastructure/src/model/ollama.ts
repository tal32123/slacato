import {
  type BudgetedModelGateway,
  createBudgetedModelGateway,
  type EmbeddingGateway,
  type EmbeddingRequestOptions,
  ModelGatewayTransportError,
  type ModelRegistry,
  type ModelTransport,
  type ModelTransportRequest,
  normalizeModelError,
  type ProviderAttemptLedger,
  type TransportGeneration
} from '@slacato/core';
import {
  APICallError,
  type EmbedManyResult,
  embedMany,
  generateText,
  jsonSchema,
  type LanguageModel,
  Output
} from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { z } from 'zod';
import type { OllamaCapabilities, OllamaCapabilityProbe } from './capabilities.js';
import {
  classifyApiCallError,
  createProviderModelRegistry,
  warningText
} from './provider-adapter-helpers.js';

export type OllamaGatewayConfig = Readonly<{
  baseURL: string;
  apiKey: string;
  generationModelId: string;
  embeddingModelId: string;
  attemptLedger: ProviderAttemptLedger;
  fetch?: typeof globalThis.fetch;
}>;

/** Converts SDK/provider structured errors to the provider-neutral core contract. */
export function normalizeOllamaTransportError(error: unknown): ModelGatewayTransportError {
  if (error instanceof ModelGatewayTransportError) return error;
  const generic = normalizeModelError(error).normalized;
  const apiError = APICallError.isInstance(error) ? error : undefined;
  const category =
    apiError === undefined
      ? generic.category
      : classifyApiCallError(apiError.statusCode, apiError.isRetryable);
  return new ModelGatewayTransportError({
    category,
    ...(generic.statusCode === undefined ? {} : { statusCode: generic.statusCode }),
    diagnosticCode: apiError === undefined ? 'ollama_unknown_error' : 'ollama_api_error',
    message: 'Ollama provider request failed'
  });
}

/** Runs Ollama generation requests behind the provider-neutral transport contract. */
class OllamaTransport implements ModelTransport {
  /** Configures generation with the selected model and verified structured-output capability. */
  public constructor(
    private readonly model: LanguageModel,
    public readonly capabilities: Readonly<{ nativeStructuredOutput: boolean }>
  ) {}

  /** Generates one model response within its deadline and translates provider failures. */
  public async generate<Value>(
    request: ModelTransportRequest<Value>
  ): Promise<TransportGeneration<Value>> {
    const timeout = Math.max(1, request.deadlineAt - Date.now());
    const common = {
      model: this.model,
      messages: request.messages.map(({ role, content }) => ({ role, content })),
      allowSystemInMessages: true,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeout)
    };
    try {
      if (request.outputMode === 'native_schema') {
        if (request.schema === undefined)
          throw new Error('Native structured generation requires a schema');
        const inputJsonSchema = z.toJSONSchema(request.schema, {
          io: 'input'
        }) as unknown as Parameters<typeof jsonSchema>[0];
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
      return {
        text: result.text,
        usage: result.usage,
        warnings: (result.warnings ?? []).map(warningText)
      };
    } catch (error) {
      throw normalizeOllamaTransportError(error);
    }
  }
}

/** Creates the authenticated Ollama client shared by generation and embedding operations. */
function createProvider(config: OllamaGatewayConfig) {
  return createOllama({
    baseURL: config.baseURL,
    headers: { Authorization: `Bearer ${config.apiKey}` },
    ...(config.fetch === undefined ? {} : { fetch: config.fetch })
  });
}

/** Creates the private Ollama adapter behind provider-neutral core ports. */
export function createOllamaModelGateways(
  config: OllamaGatewayConfig,
  capabilities: Pick<OllamaCapabilities, 'nativeStructuredOutput'>
): Readonly<{
  modelGateway: BudgetedModelGateway;
  embeddingGateway: EmbeddingGateway;
  registry: ModelRegistry;
}> {
  const provider = createProvider(config);
  const registry = createProviderModelRegistry({
    providerId: 'ollama',
    generationModelId: config.generationModelId,
    embeddingModelId: config.embeddingModelId,
    nativeStructuredOutput: capabilities.nativeStructuredOutput
  });
  return {
    modelGateway: createBudgetedModelGateway(
      new OllamaTransport(provider(config.generationModelId), capabilities),
      undefined,
      config.attemptLedger
    ),
    embeddingGateway: {
      async embed(
        values: readonly string[],
        options?: EmbeddingRequestOptions
      ): Promise<number[][]> {
        if (values.length === 0) return [];
        try {
          const result = await embedMany({
            model: provider.embedding(config.embeddingModelId),
            values: [...values],
            maxRetries: 0,
            ...(options?.signal === undefined ? {} : { abortSignal: options.signal })
          });
          return result.embeddings.map((embedding) => [...embedding]);
        } catch (error) {
          throw normalizeOllamaTransportError(error);
        }
      }
    },
    registry
  };
}

/** Lists the model IDs currently available from the configured Ollama service. */
async function listModelIds(config: OllamaGatewayConfig): Promise<readonly string[]> {
  try {
    const response = await fetch(`${config.baseURL.replace(/\/$/, '')}/tags`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw { statusCode: response.status };
    const payload: unknown = await response.json();
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('models' in payload) ||
      !Array.isArray(payload.models)
    ) {
      throw new Error('Ollama model discovery returned an invalid response');
    }
    return payload.models.flatMap((model) =>
      typeof model === 'object' &&
      model !== null &&
      'name' in model &&
      typeof model.name === 'string'
        ? [model.name]
        : []
    );
  } catch (error) {
    throw normalizeOllamaTransportError(error);
  }
}

/** Reports whether an embedding is effectively unit length. */
function isUnitNormalized(vector: readonly number[]): boolean {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return Math.abs(magnitude - 1) < 0.001;
}

/** Measures live Ollama model availability, structured-output support, and embedding properties outside run budgets. */
export async function probeOllamaCapabilities(
  config: OllamaGatewayConfig
): Promise<OllamaCapabilityProbe> {
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
      abortSignal: AbortSignal.timeout(15_000)
    });
    nativeStructuredOutput = result.output.ready === true;
    warnings.push(...(result.warnings ?? []).map(warningText));
  } catch (error) {
    warnings.push(`native_schema_probe_failed:${normalizeOllamaTransportError(error).category}`);
  }
  let embedding: EmbedManyResult;
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
  if (vector === undefined || vector.length === 0)
    throw new Error('Ollama embedding probe returned no vector');
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
