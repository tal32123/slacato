import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadinessDependencies } from '@slacato/core';
import {
  createConfiguredModelReadinessCheck,
  isRequiredMigrationApplied,
  LATEST_DRIZZLE_MIGRATION_TIMESTAMP
} from '@slacato/infrastructure';
import { HealthController } from '../../apps/api/src/modules/health/health.controller';
import { HealthService } from '../../apps/api/src/modules/health/health.service';
import { createApiApplication } from '../../apps/api/src/main';

const ready: ReadinessDependencies = {
  database: { isReady: async () => true },
  migration: { isReady: async () => true },
  redis: { isReady: async () => true },
  index: { isReady: async () => true },
  model: { isReady: async () => true }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HealthController', () => {
  it('reports process liveness without external dependencies', async () => {
    await expect(new HealthController(new HealthService(ready)).live()).resolves.toEqual({ status: 'live' });
  });

  it('converts a rejected model probe into typed non-readiness including migration', async () => {
    const service = new HealthService({ ...ready, model: { isReady: async () => Promise.reject(new Error('provider unavailable')) } });
    await expect(service.readiness()).resolves.toEqual({
      status: 'not_ready',
      checks: { database: 'ready', migration: 'ready', redis: 'ready', index: 'ready', model: 'unavailable' },
      detail: { code: 'MODEL_UNAVAILABLE', generation: 'disabled' }
    });
  });

  it('serves ready when explicit application composition supplies healthy dependency probes', async () => {
    const app = await createApiApplication({ environment: validEnvironment, readiness: ready });
    await app.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`${addressOf(app)}/api/health/ready`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: 'ready',
        checks: {
          database: 'ready',
          migration: 'ready',
          redis: 'ready',
          index: 'ready',
          model: 'ready'
        }
      });
    } finally {
      await app.close();
    }
  });

  it('serves a structured 503 when an explicit dependency probe reports unavailable', async () => {
    const app = await createApiApplication({
      environment: validEnvironment,
      readiness: { ...ready, redis: { isReady: async () => false } }
    });
    await app.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`${addressOf(app)}/api/health/ready`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        status: 'not_ready',
        checks: {
          database: 'ready',
          migration: 'ready',
          redis: 'unavailable',
          index: 'ready',
          model: 'ready'
        },
        detail: { code: 'DEPENDENCY_UNAVAILABLE', generation: 'disabled' }
      });
    } finally {
      await app.close();
    }
  });

  it('accepts the required migration level and forward-compatible applied migrations', () => {
    expect(isRequiredMigrationApplied(String(LATEST_DRIZZLE_MIGRATION_TIMESTAMP))).toBe(true);
    expect(isRequiredMigrationApplied(String(LATEST_DRIZZLE_MIGRATION_TIMESTAMP + 1))).toBe(true);
    expect(isRequiredMigrationApplied(String(LATEST_DRIZZLE_MIGRATION_TIMESTAMP - 1))).toBe(false);
  });

  it('requires both configured OpenRouter models to advertise live endpoints', async () => {
    const requested: string[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchProbe = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        requested.push(url);
        signals.push(init?.signal);
        const endpoints = url.includes('generation-model') ? [{ name: 'available' }] : [];
        return new Response(JSON.stringify({ data: { endpoints } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    );
    vi.stubGlobal('fetch', fetchProbe);

    const check = createConfiguredModelReadinessCheck({
      provider: 'openrouter',
      generationModel: 'openai/generation-model',
      embeddingModel: 'openai/embedding-model',
      apiKey: 'test-key'
    });

    await expect(check.isReady()).resolves.toBe(false);
    expect(requested).toEqual([
      'https://openrouter.ai/api/v1/models/openai/generation-model/endpoints',
      'https://openrouter.ai/api/v1/models/openai/embedding-model/endpoints'
    ]);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
  });
});

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/slacato',
  SESSION_SECRET: 'a-session-secret-that-is-at-least-32-characters',
  OLLAMA_API_KEY: 'test-key',
  OLLAMA_CHAT_MODEL: 'test-chat',
  OLLAMA_EMBEDDING_MODEL: 'test-embedding'
};

function addressOf(app: { getHttpServer(): { address(): unknown } }): string {
  const address = app.getHttpServer().address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}
