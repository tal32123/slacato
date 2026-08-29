import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  type BudgetedModelGateway,
  createBudgetedModelGateway,
  type EmbeddingGateway,
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
  embedMany,
  generateText,
  InvalidPromptError,
  jsonSchema,
  type LanguageModel,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output
} from 'ai';
import { z } from 'zod';
import { openRouterDiagnosticCode } from './openrouter-diagnostics.js';
import {
  classifyApiCallError,
  createProviderModelRegistry,
  warningText
} from './provider-adapter-helpers.js';

export type OpenRouterGatewayConfig = Readonly<{
  apiKey: string;
  generationModelId: string;
  embeddingModelId: string;
  attemptLedger: ProviderAttemptLedger;
  fetch?: typeof globalThis.fetch;
}>;

const UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems'
]);

/** Keeps the full Zod schema for local validation while sending only Gemini's documented JSON Schema subset. */
export function providerJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(providerJsonSchema);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS.has(key))
      .map(([key, nested]) => [key, providerJsonSchema(nested)])
  );
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
      diagnosticCode:
        finishReason === 'length'
          ? 'openrouter_invalid_object_length'
          : 'openrouter_invalid_object',
      message: 'OpenRouter returned output that did not satisfy the required schema'
    });
  }
  const generic = normalizeModelError(error).normalized;
  const apiError = APICallError.isInstance(error) ? error : undefined;
  const category =
    apiError === undefined
      ? generic.category
      : classifyApiCallError(apiError.statusCode, apiError.isRetryable);
  return new ModelGatewayTransportError({
    category,
    ...(generic.statusCode === undefined ? {} : { statusCode: generic.statusCode }),
    diagnosticCode:
      apiError === undefined
        ? 'openrouter_unknown_error'
        : openRouterDiagnosticCode(apiError.statusCode, apiError.responseBody),
    message: 'OpenRouter provider request failed'
  });
}

/** Runs OpenRouter generation requests behind the provider-neutral transport contract. */
class OpenRouterTransport implements ModelTransport {
  public readonly capabilities = { nativeStructuredOutput: true } as const;

  /** Configures generation with the selected OpenRouter language model. */
  public constructor(private readonly model: LanguageModel) {}

  /** Generates one model response within its deadline and translates provider failures. */
  public async generate<Value>(
    request: ModelTransportRequest<Value>
  ): Promise<TransportGeneration<Value>> {
    const instructions = request.messages
      .filter(({ role }) => role === 'system')
      .map(({ content }) => content)
      .join('\n\n');
    const common = {
      model: this.model,
      messages: request.messages
        .filter(({ role }) => role !== 'system')
        .map(({ role, content }) => ({ role, content })),
      ...(instructions.length === 0 ? {} : { instructions }),
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(Math.max(1, request.deadlineAt - Date.now()))
    };
    try {
      if (request.outputMode === 'native_schema') {
        if (request.schema === undefined)
          throw new Error('Native structured generation requires a schema');
        const inputJsonSchema = providerJsonSchema(
          z.toJSONSchema(request.schema, { io: 'input' })
        ) as Parameters<typeof jsonSchema>[0];
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
              usage: result.usage,
              warnings: (result.warnings ?? []).map(warningText)
            };
          }
        } catch (error) {
          if (!NoObjectGeneratedError.isInstance(error)) throw error;
          return {
            text: error.text ?? '',
            ...(error.usage === undefined ? {} : { usage: error.usage }),
            ...(error.response?.id === undefined ? {} : { requestId: error.response.id }),
            warnings: []
          };
        }
      }
      const result = await generateText(common);
      return {
        text: result.text,
        usage: result.usage,
        warnings: (result.warnings ?? []).map(warningText)
      };
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
  const registry = createProviderModelRegistry({
    providerId: 'openrouter',
    generationModelId: config.generationModelId,
    embeddingModelId: config.embeddingModelId,
    nativeStructuredOutput: true
  });
  return {
    modelGateway: createBudgetedModelGateway(
      new OpenRouterTransport(provider.chat(config.generationModelId)),
      undefined,
      config.attemptLedger
    ),
    embeddingGateway: {
      async embed(values: readonly string[]): Promise<number[][]> {
        if (values.length === 0) return [];
        try {
          const result = await embedMany({
            model: provider.textEmbeddingModel(config.embeddingModelId),
            values: [...values],
            maxRetries: 0
          });
          return result.embeddings.map((embedding) => [...embedding]);
        } catch (error) {
          throw normalizeOpenRouterTransportError(error);
        }
      }
    },
    registry
  };
}
