import { describe, expect, it } from 'vitest';
import { envSchema } from '@slacato/infrastructure/config/env';
import { createConfiguredModelGateways } from '@slacato/infrastructure';
import { z } from 'zod';

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

  it('fails mock composition immediately when no fixture resolver is supplied', () => {
    expect(() => createConfiguredModelGateways(envSchema.parse(baseEnvironment))).toThrow('mock fixture resolver');
  });

  it('uses an explicit mock fixture resolver through schema repair in the real gateway', async () => {
    const outputs = ['{"value":"invalid"}', '{"value":"valid"}'];
    const gateways = createConfiguredModelGateways(envSchema.parse(baseEnvironment), {
      mock: { resolve: async () => ({ text: outputs.shift() ?? '{}', usage: { outputTokens: 1 } }) }
    });
    const result = await gateways.modelGateway.generateObject({
      schema: z.object({ value: z.literal('valid') }).strict(),
      messages: [{ role: 'user', content: 'Return valid JSON.' }], operation: 'mock-composition',
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 100 }
    });

    expect(gateways).toMatchObject({ provider: 'mock', embeddingProfile: { dimension: 64 } });
    expect(gateways.registry.resolve('specialist')).toMatchObject({ providerId: 'mock', modelId: 'mock-specialist' });
    expect(result.value).toEqual({ value: 'valid' });
    expect(result.attempts).toHaveLength(2);
  });

  it('selects Ollama without requiring or accepting a mock fixture resolver', () => {
    const environment = envSchema.parse({
      ...baseEnvironment, AI_PROVIDER: 'ollama', OLLAMA_API_KEY: 'server-only-key', OLLAMA_CHAT_MODEL: 'chat', OLLAMA_EMBEDDING_MODEL: 'embed'
    });
    expect(createConfiguredModelGateways(environment).registry.resolve('brief')).toMatchObject({ providerId: 'ollama', modelId: 'chat' });
    expect(() => createConfiguredModelGateways(environment, { mock: { resolve: async () => ({ text: '{}' }) } })).toThrow('Ollama composition does not accept a mock fixture resolver');
  });
});

const baseEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/slacato',
  SESSION_SECRET: 'a-session-secret-that-is-at-least-32-characters'
};
