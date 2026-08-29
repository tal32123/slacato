import {
  APICallError, embedMany, generateText, InvalidPromptError, jsonSchema, NoObjectGeneratedError,
  NoOutputGeneratedError, Output, type LanguageModel
} from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import {
  createBudgetedModelGateway,
  ModelGatewayTransportError,
  ModelRegistry,
  normalizeModelError,
  type BudgetedModelGateway,
  type EmbeddingGateway,
  type ModelErrorCategory,
  type ModelTransport,
  type ModelTransportRequest,
  type ProviderAttemptLedger,
  type TransportGeneration
} from '@slacato/core';

export type OpenRouterGatewayConfig = Readonly<{
  apiKey: string;
  generationModelId: string;
  embeddingModelId: string;
  attemptLedger: ProviderAttemptLedger;
  fetch?: typeof globalThis.fetch;
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

/** Keeps provider response bodies and credentials behind the safe model error boundary. */
export function normalizeOpenRouterTransportError(error: unknown): ModelGatewayTransportError {
  if (error instanceof ModelGatewayTransportError) return error;
  if (InvalidPromptError.isInstance(error)) {
    return new ModelGatewayTransportError({
      category: 'deterministic_validation',
      diagnosticCode: 'openrouter_invalid_prompt',
      message: 'The model prompt does not satisfy the AI SDK contract'
    });
  }
  if (NoOutputGeneratedError.isInstance(error)) {
    return new ModelGatewayTransportError({
      category: 'deterministic_validation',
      diagnosticCode: 'openrouter_no_output',
      message: 'OpenRouter returned no model output'
    });
  }
  if (NoObjectGeneratedError.isInstance(error)) {
    const finishReason = error.finishReason;
    return new ModelGatewayTransportError({
      category: finishReason === 'content-filter' ? 'content_filter' : 'deterministic_validation',
      diagnosticCode: finishReason === 'length' ? 'openrouter_invalid_object_length' : 'openrouter_invalid_object',
      message: 'OpenRouter returned output that did not satisfy the required schema'
    });
  }
  const generic = normalizeModelError(error).normalized;
  const apiError = APICallError.isInstance(error) ? error : undefined;
  const category = apiError === undefined ? generic.category : categoryForApiCallError(apiError);
  return new ModelGatewayTransportError({
    category,
    ...(generic.statusCode === undefined ? {} : { statusCode: generic.statusCode }),
    diagnosticCode: apiError === undefined ? 'openrouter_unknown_error' : 'openrouter_api_error',
    message: 'OpenRouter provider request failed'
  });
}

class OpenRouterTransport implements ModelTransport {
  public readonly capabilities = { nativeStructuredOutput: true } as const;

  public constructor(private readonly model: LanguageModel) {}

  public async generate<Value>(request: ModelTransportRequest<Value>): Promise<TransportGeneration<Value>> {
    const instructions = request.messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n\n');
    const common = {
      model: this.model,
      messages: request.messages.filter(({ role }) => role !== 'system').map(({ role, content }) => ({ role, content })),
      ...(instructions.length === 0 ? {} : { instructions }),
      maxRetries: 0,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: AbortSignal.timeout(Math.max(1, request.deadlineAt - Date.now()))
    };
    try {
      if (request.outputMode === 'native_schema') {
        if (request.schema === undefined) throw new Error('Native structured generation requires a schema');
        const inputJsonSchema = z.toJSONSchema(request.schema, { io: 'input' }) as unknown as Parameters<typeof jsonSchema>[0];
        try {
          const result = await generateText({
            ...common,
            output: Output.object({ schema: jsonSchema(inputJsonSchema) })
          });
          try {
            return {
              text: result.text,
              output: result.output as Value,
              usage: result.usage,
              warnings: (result.warnings ?? []).map(warningText)
            };
          } catch (error) {
            if (!NoOutputGeneratedError.isInstance(error)) throw error;
            return {
              text: result.text,
              output: undefined,
              usage: result.usage,
              warnings: (result.warnings ?? []).map(warningText)
            };
          }
        } catch (error) {
          if (!NoObjectGeneratedError.isInstance(error)) throw error;
          return {
            text: error.text ?? '',
            output: undefined,
            usage: error.usage,
            requestId: error.response?.id,
            warnings: []
          };
        }
      }
      const result = await generateText(common);
      return { text: result.text, usage: result.usage, warnings: (result.warnings ?? []).map(warningText) };
    } catch (error) {
      throw normalizeOpenRouterTransportError(error);
    }
  }
}

/** Uses OpenRouter's AI SDK provider so routing, embeddings, and structured output share one native adapter. */
export function createOpenRouterModelGateways(config: OpenRouterGatewayConfig): Readonly<{
  modelGateway: BudgetedModelGateway;
  embeddingGateway: EmbeddingGateway;
  registry: ModelRegistry;
}> {
  const provider = createOpenRouter({
    apiKey: config.apiKey,
    appName: 'SlaCato',
    compatibility: 'strict',
    extraBody: { provider: { allow_fallbacks: true, require_parameters: true } },
    ...(config.fetch === undefined ? {} : { fetch: config.fetch })
  });
  const registry = new ModelRegistry();
  const languageModel = { providerId: 'openrouter', modelId: config.generationModelId, nativeStructuredOutput: true };
  registry.register('brief', languageModel);
  registry.register('specialist', languageModel);
  registry.register('compaction', languageModel);
  registry.register('embedding', { providerId: 'openrouter', modelId: config.embeddingModelId });
  return {
    modelGateway: createBudgetedModelGateway(new OpenRouterTransport(provider.chat(config.generationModelId)), undefined, config.attemptLedger),
    embeddingGateway: {
      async embed(values: readonly string[]): Promise<number[][]> {
        if (values.length === 0) return [];
        try {
        const result = await embedMany({ model: provider.textEmbeddingModel(config.embeddingModelId), values: [...values], maxRetries: 0 });
          return result.embeddings.map((embedding) => [...embedding]);
        } catch (error) {
          throw normalizeOpenRouterTransportError(error);
        }
      }
    },
    registry
  };
}
