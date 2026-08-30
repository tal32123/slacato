import { describe, expect, it } from 'vitest';
import { envSchema, parseEnv } from '@slacato/infrastructure/config/env';
import { createConfiguredModelGateways, createDatabaseClient, PostgresProviderAttemptLedger, PROVIDER_REGISTRY } from '@slacato/infrastructure';

describe('envSchema', () => {
  it('rejects a configuration without server secrets', () => {
    expect(() => envSchema.parse({ NODE_ENV: 'test' })).toThrow();
  });

  it('defaults to mock mode without Ollama credentials or model IDs', () => {
    expect(envSchema.parse(baseEnvironment)).toMatchObject({ AI_PROVIDER: 'mock' });
  });

  it('reads known server configuration from a real process environment containing unrelated keys', () => {
    expect(parseEnv({ ...baseEnvironment, PATH: '/usr/bin', SHELL: '/bin/zsh' })).toMatchObject({
      NODE_ENV: 'test', AI_PROVIDER: 'mock', WEB_ORIGIN: 'http://127.0.0.1:4173'
    });
  });

  it('rejects a web allowlist entry that is not an exact URL origin', () => {
    expect(() => envSchema.parse({ ...baseEnvironment, WEB_ORIGIN: 'http://127.0.0.1:4173/path' })).toThrow();
  });

  it('requires the complete Ollama credential/model tuple only in ollama mode', () => {
    expect(() => envSchema.parse({ ...baseEnvironment, AI_PROVIDER: 'ollama' })).toThrow();
    expect(envSchema.parse({
      ...baseEnvironment,
      AI_PROVIDER: 'ollama',
      OLLAMA_API_KEY: 'server-only-key',
      OLLAMA_CHAT_MODEL: 'chat-model',
      OLLAMA_EMBEDDING_MODEL: 'embedding-model'
    })).toMatchObject({ AI_PROVIDER: 'ollama', OLLAMA_CHAT_MODEL: 'chat-model' });
  });

  it('requires an OpenRouter API key and supplies fixed model defaults in openrouter mode', () => {
    expect(() => envSchema.parse({ ...baseEnvironment, AI_PROVIDER: 'openrouter' })).toThrow();
    expect(envSchema.parse({
      ...baseEnvironment,
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'server-only-key'
    })).toMatchObject({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_CHAT_MODEL: 'openai/gpt-5.6-luna',
      OPENROUTER_EMBEDDING_MODEL: 'openai/text-embedding-3-small'
    });
  });

  it('fails mock composition immediately when no fixture resolver is supplied', () => {
    expect(() => createConfiguredModelGateways(envSchema.parse(baseEnvironment), {} as never)).toThrow('mock fixture resolver');
  });

  it('constructs mock composition only with an explicit fixture resolver and durable database', async () => {
    const database = createDatabaseClient(baseEnvironment.DATABASE_URL, 1);
    const gateways = createConfiguredModelGateways(envSchema.parse(baseEnvironment), {
      attemptLedger: new PostgresProviderAttemptLedger(database),
      mock: { resolve: async () => ({ text: '{}' }) }
    });

    expect(gateways).toMatchObject({ provider: 'mock', embeddingProfile: { dimension: 64 } });
    expect(gateways.registry.resolve('specialist')).toMatchObject({ providerId: 'mock', modelId: 'mock-specialist' });
    await database.close();
  });

  it('selects Ollama without requiring or accepting a mock fixture resolver', () => {
    const database = createDatabaseClient(baseEnvironment.DATABASE_URL, 1);
    const environment = envSchema.parse({
      ...baseEnvironment, AI_PROVIDER: 'ollama', OLLAMA_API_KEY: 'server-only-key', OLLAMA_CHAT_MODEL: 'chat', OLLAMA_EMBEDDING_MODEL: 'embed'
    });
    const attemptLedger = new PostgresProviderAttemptLedger(database);
    expect(createConfiguredModelGateways(environment, { attemptLedger }).registry.resolve('brief')).toMatchObject({ providerId: 'ollama', modelId: 'chat' });
    expect(() => createConfiguredModelGateways(environment, { attemptLedger, mock: { resolve: async () => ({ text: '{}' }) } })).toThrow('Ollama composition does not accept a mock fixture resolver');
    void database.close();
  });

  it('selects OpenRouter for structured generation and embeddings without accepting a mock resolver', () => {
    const database = createDatabaseClient(baseEnvironment.DATABASE_URL, 1);
    const environment = envSchema.parse({
      ...baseEnvironment, AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'server-only-key'
    });
    const attemptLedger = new PostgresProviderAttemptLedger(database);
    const gateways = createConfiguredModelGateways(environment, { attemptLedger });

    expect(gateways.provider).toBe('openrouter');
    expect(gateways.registry.resolve('brief')).toMatchObject({ providerId: 'openrouter', modelId: 'openai/gpt-5.6-luna', nativeStructuredOutput: true });
    expect(gateways.registry.resolve('embedding')).toMatchObject({ providerId: 'openrouter', modelId: 'openai/text-embedding-3-small' });
    expect(() => createConfiguredModelGateways(environment, {
      attemptLedger, mock: { resolve: async () => ({ text: '{}' }) }
    })).toThrow('OpenRouter composition does not accept a mock fixture resolver');
    void database.close();
  });
});

describe('PROVIDER_REGISTRY', () => {
  it('declares exactly one descriptor for every AI_PROVIDER literal the environment schema accepts', () => {
    const schemaProviders = discriminatedUnionProviders().sort();
    const registryProviders = Object.keys(PROVIDER_REGISTRY).sort();

    expect(registryProviders).toEqual(schemaProviders);
  });

  it('keys every descriptor by its own provider id so a lookup cannot return another provider', () => {
    for (const [id, descriptor] of Object.entries(PROVIDER_REGISTRY)) expect(descriptor.id).toBe(id);
  });

  it('supplies the whole per-provider behaviour set in every descriptor', () => {
    for (const descriptor of Object.values(PROVIDER_REGISTRY)) {
      expect(typeof descriptor.createGateways).toBe('function');
      expect(typeof descriptor.workerCompositionOptions).toBe('function');
      expect(typeof descriptor.models).toBe('function');
      expect(typeof descriptor.readinessCredentials).toBe('function');
      expect(typeof descriptor.readinessProbe).toBe('function');
      expect(['deterministic_mock', 'capability_probe_required', 'native_schema']).toContain(descriptor.outputMode);
    }
  });
});

/** Reads the AI_PROVIDER literals straight out of the parsed environment's discriminated union. */
function discriminatedUnionProviders(): string[] {
  const pipe = envSchema as unknown as { def: { out: { def: { options: readonly unknown[] } } } };
  return pipe.def.out.def.options.map((option) => {
    const shape = (option as { def: { shape: { AI_PROVIDER: { def: { values: readonly string[] } } } } }).def.shape;
    const [literal] = shape.AI_PROVIDER.def.values;
    if (literal === undefined) throw new Error('AI_PROVIDER branch is missing its literal value');
    return literal;
  });
}

const baseEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/slacato',
  SESSION_SECRET: 'a-session-secret-that-is-at-least-32-characters'
};
