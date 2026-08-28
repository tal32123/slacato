import { describe, expect, it } from 'vitest';
import { envSchema } from '@slacato/infrastructure/config/env';
import { createConfiguredModelGateways } from '@slacato/infrastructure';

describe('envSchema', () => {
  it('rejects a configuration without server secrets', () => {
    expect(() => envSchema.parse({ NODE_ENV: 'test' })).toThrow();
  });

  it('defaults to mock mode without Ollama credentials or model IDs', () => {
    expect(envSchema.parse(baseEnvironment)).toMatchObject({ AI_PROVIDER: 'mock' });
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

  it('selects the deterministic mock adapter for the default environment', () => {
    const gateways = createConfiguredModelGateways(envSchema.parse(baseEnvironment));
    expect(gateways).toMatchObject({ provider: 'mock', embeddingProfile: { dimension: 64 } });
    expect(gateways.registry.resolve('specialist')).toMatchObject({ providerId: 'mock', modelId: 'mock-specialist' });
  });
});

const baseEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/slacato',
  SESSION_SECRET: 'a-session-secret-that-is-at-least-32-characters'
};
