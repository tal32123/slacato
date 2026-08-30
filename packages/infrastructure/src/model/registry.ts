import type { ProviderHealthView } from '@slacato/contracts';
import type {
  BudgetedModelGateway,
  EmbeddingGateway,
  GenerateObjectRequest,
  GenerationResult,
  ModelRegistry,
  RunBudgetLimits
} from '@slacato/core';
import type { Env } from '../config/env.js';
import type { PostgresProviderAttemptLedger } from '../db/repositories/provider-attempt-ledger.js';
import type { OllamaCapabilities } from './capabilities.js';
import {
  createMockModelGateways,
  type MOCK_EMBEDDING_PROFILE,
  type MockGenerationResolver,
  type MockModelGatewayOptions
} from './mock.js';
import { createOllamaModelGateways } from './ollama.js';
import { createOpenRouterModelGateways } from './openrouter.js';

const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';

/** Every AI provider the validated environment can select, derived from the environment schema. */
export type AiProvider = Env['AI_PROVIDER'];

/** Narrows the validated environment to the variant guaranteed by one provider selection. */
export type EnvFor<Provider extends AiProvider> = Extract<Env, Readonly<{ AI_PROVIDER: Provider }>>;

export type ConfiguredModelGateways = Readonly<{
  provider: AiProvider;
  embeddingGateway: EmbeddingGateway;
  registry: ModelRegistry;
  embeddingProfile?: typeof MOCK_EMBEDDING_PROFILE;
  /** Verifies the workflow-created durable budget before returning a scoped gateway. */
  forRun(input: ProviderRunScope): Promise<RunScopedModelGateway>;
  /** Run-scoped embedding path sharing the same durable deadline and attempt ledger. */
  embeddingForRun(input: ProviderRunScope): Promise<EmbeddingGateway>;
}>;

export type ProviderRunScope = Readonly<{
  runScope: string;
  invocationId?: string;
  logicalGenerationId?: string;
  budget: RunBudgetLimits;
}>;
export type RunScopedModelGateway = Readonly<{
  generateObject<Value>(
    request: Omit<GenerateObjectRequest<Value>, 'durableAttempt'>
  ): Promise<GenerationResult<Value>>;
}>;

export type MockCompositionOptions = Readonly<{
  attemptLedger: PostgresProviderAttemptLedger;
  mock: Omit<MockModelGatewayOptions, 'attemptLedger'>;
  ollamaCapabilities?: never;
}>;
export type OllamaCompositionOptions = Readonly<{
  attemptLedger: PostgresProviderAttemptLedger;
  mock?: undefined;
  ollamaCapabilities?: Pick<OllamaCapabilities, 'nativeStructuredOutput'>;
}>;
export type OpenRouterCompositionOptions = Readonly<{
  attemptLedger: PostgresProviderAttemptLedger;
  mock?: undefined;
  ollamaCapabilities?: never;
}>;

/** Any provider's composition options; each descriptor rejects the shapes it cannot honour. */
export type ProviderCompositionOptions =
  | MockCompositionOptions
  | OllamaCompositionOptions
  | OpenRouterCompositionOptions;

/** Provider-specific worker overrides expressed as one closed union of optional shapes. */
export type WorkerCompositionOverrides = Readonly<{
  mockFixtureResolver?: MockGenerationResolver;
  ollamaCapabilities?: Pick<OllamaCapabilities, 'nativeStructuredOutput'>;
}>;

/** Inputs a descriptor needs to turn uniform worker overrides into its own composition options. */
export type WorkerCompositionInput = Readonly<{
  attemptLedger: PostgresProviderAttemptLedger;
  overrides: WorkerCompositionOverrides;
}>;

/** Pinned generation and embedding model identifiers for the configured provider. */
export type ProviderModels = Readonly<{ generation: string; embedding: string }>;

/** Provider runtime facts diagnostics reports without reconstructing them from configuration. */
export type ProviderRuntimeFacts = Readonly<
  Pick<
    ProviderHealthView,
    'provider' | 'outputMode' | 'pinnedGenerationModel' | 'pinnedEmbeddingModel'
  >
>;

/** Provider credentials the readiness probe needs, absent for providers that require none. */
export type ProviderReadinessCredentials = Readonly<{
  ollamaBaseUrl?: string;
  apiKey?: string;
}>;

/** The fully resolved provider target that readiness checks probe. */
export type ConfiguredProvider = Readonly<{
  provider: AiProvider;
  generationModel: string;
  embeddingModel: string;
}> &
  ProviderReadinessCredentials;

/** Everything that varies per AI provider, declared once so a new provider cannot be half-added. */
export type ProviderDescriptor<Provider extends AiProvider = AiProvider> = {
  readonly id: Provider;
  /** Builds the run-scoped model and embedding gateways for this provider. */
  createGateways(
    environment: EnvFor<Provider>,
    options: ProviderCompositionOptions
  ): ConfiguredModelGateways;
  /** Translates uniform worker overrides into this provider's composition options. */
  workerCompositionOptions(input: WorkerCompositionInput): ProviderCompositionOptions;
  /** Reports the pinned model identifiers this provider runs with. */
  models(environment: EnvFor<Provider>): ProviderModels;
  /** The structured-output mode diagnostics reports for this provider. */
  readonly outputMode: ProviderRuntimeFacts['outputMode'];
  /** Supplies the credentials the readiness probe requires, or nothing when none apply. */
  readinessCredentials(environment: EnvFor<Provider>): ProviderReadinessCredentials;
  /** Checks that the configured models are advertised by this provider. */
  readinessProbe(configured: ConfiguredProvider, signal: AbortSignal): Promise<boolean>;
};

/** Wraps an embedding gateway so every call is metered against the run's durable budget. */
const runScopedEmbedding =
  (
    gateway: EmbeddingGateway,
    attemptLedger: PostgresProviderAttemptLedger,
    provider: AiProvider,
    model: string
  ) =>
  async (input: ProviderRunScope): Promise<EmbeddingGateway> => {
    if (input.budget.scope !== input.runScope)
      throw new Error('Run budget scope must match the gateway run scope');
    await attemptLedger.assertRunBudget(input.budget);
    return {
      async embed(values: readonly string[]) {
        await attemptLedger.remainingDeadlineMs(input.runScope);
        const inputTokens = Math.max(
          1,
          Math.ceil(values.reduce((total, value) => total + value.length, 0) / 4)
        );
        const reservation = await attemptLedger.beginAttempt({
          runScope: input.runScope,
          ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
          logicalGenerationId: input.logicalGenerationId ?? `embedding:${input.runScope}`,
          provider,
          model,
          operation: 'retrieval-embedding',
          inputTokens,
          requestedOutputTokens: 1
        });
        try {
          const output = await gateway.embed(values);
          await attemptLedger.remainingDeadlineMs(input.runScope);
          await attemptLedger.settleAttempt({
            ...reservation,
            reservedInputTokens: inputTokens,
            actualInputTokens: inputTokens,
            actualOutputTokens: 1
          });
          return output;
        } catch (error) {
          await attemptLedger.releaseAttempt({
            ...reservation,
            disposition: 'possibly_sent',
            category: 'embedding_failure',
            diagnosticCode: 'retrieval_embedding_failed'
          });
          throw error;
        }
      }
    };
  };

/** Wraps a budgeted model gateway so every generation inherits the run's durable deadline. */
const runScoped =
  (
    gateway: BudgetedModelGateway,
    attemptLedger: PostgresProviderAttemptLedger,
    provider: AiProvider,
    model: string
  ) =>
  async (input: ProviderRunScope): Promise<RunScopedModelGateway> => {
    if (input.budget.scope !== input.runScope)
      throw new Error('Run budget scope must match the gateway run scope');
    await attemptLedger.assertRunBudget(input.budget);
    return {
      async generateObject<Value>(request: Omit<GenerateObjectRequest<Value>, 'durableAttempt'>) {
        const remainingDeadlineMs = await attemptLedger.remainingDeadlineMs(input.runScope);
        return gateway.generateObject({
          ...request,
          limits: {
            ...request.limits,
            deadlineMs: Math.min(request.limits.deadlineMs, remainingDeadlineMs)
          },
          durableAttempt: {
            runScope: input.runScope,
            ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
            ...(input.logicalGenerationId === undefined
              ? {}
              : { logicalGenerationId: input.logicalGenerationId }),
            provider,
            model
          }
        });
      }
    };
  };

/** Rejects a mock fixture resolver supplied to a live provider that cannot honour it. */
const rejectMockFixtures = (options: ProviderCompositionOptions, message: string): void => {
  if ('mock' in options && options.mock !== undefined) throw new Error(message);
};

/** Fails a probe unless the provider credential required to query its catalogue is present. */
const hasApiKey = (configured: ConfiguredProvider): boolean =>
  configured.apiKey !== undefined && configured.apiKey.length > 0;

/**
 * The single place every provider-specific behaviour is declared. The `satisfies` check below makes
 * adding an `AI_PROVIDER` literal without a matching entry here a compile error.
 */
export const PROVIDER_REGISTRY = {
  mock: {
    id: 'mock',
    createGateways: (_environment, options) => {
      if (
        !('mock' in options) ||
        options.mock === undefined ||
        typeof options.mock.resolve !== 'function'
      ) {
        throw new Error('Mock composition requires a mock fixture resolver');
      }
      const attemptLedger = options.attemptLedger;
      const mock = createMockModelGateways({ ...options.mock, attemptLedger });
      return {
        provider: 'mock',
        embeddingGateway: mock.embeddingGateway,
        registry: mock.registry,
        embeddingProfile: mock.embeddingProfile,
        forRun: runScoped(
          mock.modelGateway,
          attemptLedger,
          'mock',
          mock.registry.resolve('brief').modelId
        ),
        embeddingForRun: runScopedEmbedding(
          mock.embeddingGateway,
          attemptLedger,
          'mock',
          mock.registry.resolve('embedding').modelId
        )
      };
    },
    workerCompositionOptions: ({ attemptLedger, overrides }) => {
      if (overrides.mockFixtureResolver === undefined)
        throw new Error('Worker mock model composition requires a fixture resolver');
      return { attemptLedger, mock: { resolve: overrides.mockFixtureResolver } };
    },
    models: () => ({ generation: 'mock-brief', embedding: 'mock-embedding' }),
    outputMode: 'deterministic_mock',
    readinessCredentials: () => ({}),
    readinessProbe: async (configured) =>
      configured.generationModel.length > 0 && configured.embeddingModel.length > 0
  },
  ollama: {
    id: 'ollama',
    createGateways: (environment, options) => {
      rejectMockFixtures(options, 'Ollama composition does not accept a mock fixture resolver');
      const attemptLedger = options.attemptLedger;
      const ollama = createOllamaModelGateways(
        {
          baseURL: environment.OLLAMA_BASE_URL,
          apiKey: environment.OLLAMA_API_KEY,
          generationModelId: environment.OLLAMA_CHAT_MODEL,
          embeddingModelId: environment.OLLAMA_EMBEDDING_MODEL,
          attemptLedger
        },
        options.ollamaCapabilities ?? { nativeStructuredOutput: false }
      );
      return {
        provider: 'ollama',
        embeddingGateway: ollama.embeddingGateway,
        registry: ollama.registry,
        forRun: runScoped(
          ollama.modelGateway,
          attemptLedger,
          'ollama',
          environment.OLLAMA_CHAT_MODEL
        ),
        embeddingForRun: runScopedEmbedding(
          ollama.embeddingGateway,
          attemptLedger,
          'ollama',
          environment.OLLAMA_EMBEDDING_MODEL
        )
      };
    },
    workerCompositionOptions: ({ attemptLedger, overrides }) => ({
      attemptLedger,
      ...(overrides.ollamaCapabilities === undefined
        ? {}
        : { ollamaCapabilities: overrides.ollamaCapabilities })
    }),
    models: (environment) => ({
      generation: environment.OLLAMA_CHAT_MODEL,
      embedding: environment.OLLAMA_EMBEDDING_MODEL
    }),
    outputMode: 'capability_probe_required',
    readinessCredentials: (environment) => ({
      ollamaBaseUrl: environment.OLLAMA_BASE_URL,
      apiKey: environment.OLLAMA_API_KEY
    }),
    readinessProbe: async (configured, signal) => {
      if (!hasApiKey(configured)) return false;
      if (configured.ollamaBaseUrl === undefined) return false;
      const response = await fetch(`${configured.ollamaBaseUrl.replace(/\/$/, '')}/tags`, {
        headers: { Authorization: `Bearer ${configured.apiKey}` },
        signal
      });
      if (!response.ok) return false;
      const payload: unknown = await response.json();
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('models' in payload) ||
        !Array.isArray(payload.models)
      )
        return false;
      const models = new Set(
        payload.models.flatMap((model) =>
          typeof model === 'object' &&
          model !== null &&
          'name' in model &&
          typeof model.name === 'string'
            ? [model.name]
            : []
        )
      );
      return models.has(configured.generationModel) && models.has(configured.embeddingModel);
    }
  },
  openrouter: {
    id: 'openrouter',
    createGateways: (environment, options) => {
      rejectMockFixtures(options, 'OpenRouter composition does not accept a mock fixture resolver');
      const attemptLedger = options.attemptLedger;
      const openrouter = createOpenRouterModelGateways({
        apiKey: environment.OPENROUTER_API_KEY,
        generationModelId: environment.OPENROUTER_CHAT_MODEL,
        embeddingModelId: environment.OPENROUTER_EMBEDDING_MODEL,
        attemptLedger
      });
      return {
        provider: 'openrouter',
        embeddingGateway: openrouter.embeddingGateway,
        registry: openrouter.registry,
        forRun: runScoped(
          openrouter.modelGateway,
          attemptLedger,
          'openrouter',
          environment.OPENROUTER_CHAT_MODEL
        ),
        embeddingForRun: runScopedEmbedding(
          openrouter.embeddingGateway,
          attemptLedger,
          'openrouter',
          environment.OPENROUTER_EMBEDDING_MODEL
        )
      };
    },
    workerCompositionOptions: ({ attemptLedger }) => ({ attemptLedger }),
    models: (environment) => ({
      generation: environment.OPENROUTER_CHAT_MODEL,
      embedding: environment.OPENROUTER_EMBEDDING_MODEL
    }),
    outputMode: 'native_schema',
    readinessCredentials: (environment) => ({ apiKey: environment.OPENROUTER_API_KEY }),
    readinessProbe: async (configured, signal) => {
      if (!hasApiKey(configured)) return false;
      const models = [...new Set([configured.generationModel, configured.embeddingModel])];
      const availability = await Promise.all(
        models.map(async (model) => {
          const modelPath = model.split('/').map(encodeURIComponent).join('/');
          const response = await fetch(`${OPENROUTER_API_BASE_URL}/models/${modelPath}/endpoints`, {
            headers: { Authorization: `Bearer ${configured.apiKey}` },
            signal
          });
          if (!response.ok) return false;
          const payload: unknown = await response.json();
          return (
            typeof payload === 'object' &&
            payload !== null &&
            'data' in payload &&
            typeof payload.data === 'object' &&
            payload.data !== null &&
            'endpoints' in payload.data &&
            Array.isArray(payload.data.endpoints) &&
            payload.data.endpoints.length > 0
          );
        })
      );
      return availability.every(Boolean);
    }
  }
} satisfies { readonly [Provider in AiProvider]: ProviderDescriptor<Provider> };

/** Selects the descriptor for the configured provider, widened for uniform composition use. */
export const resolveProviderDescriptor = (environment: Env): ProviderDescriptor =>
  PROVIDER_REGISTRY[environment.AI_PROVIDER];
