import { describe, expect, it } from 'vitest';
import { configuredProviderModels, createApiApplication } from '../../apps/api/src/main';
import { createWorkerApplication } from '../../apps/worker/src/main';
import { envSchema } from '@slacato/infrastructure/config/env';

describe('server composition roots', () => {
  it('rejects API startup before Nest creates an application when required secrets are missing', async () => {
    await expect(createApiApplication({ environment: { NODE_ENV: 'test' } })).rejects.toThrow();
  });

  it('rejects worker startup before Nest creates a long-lived worker when required secrets are missing', async () => {
    await expect(createWorkerApplication({ environment: { NODE_ENV: 'test' } })).rejects.toThrow();
  });

  it('pins OpenRouter model IDs in run and diagnostics composition', () => {
    const environment = envSchema.parse({
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/slacato',
      SESSION_SECRET: 'a-session-secret-that-is-at-least-32-characters',
      AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'server-only-key',
      OPENROUTER_CHAT_MODEL: 'anthropic/claude-sonnet-4.5',
      OPENROUTER_EMBEDDING_MODEL: 'openai/text-embedding-3-small'
    });

    expect(configuredProviderModels(environment)).toEqual({
      generation: 'anthropic/claude-sonnet-4.5', embedding: 'openai/text-embedding-3-small'
    });
  });
});
