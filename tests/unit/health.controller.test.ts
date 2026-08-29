import { describe, expect, it } from 'vitest';
import { HealthController } from '../../apps/api/src/modules/health/health.controller';
import { HealthService } from '../../apps/api/src/modules/health/health.service';
import { createApiApplication } from '../../apps/api/src/main';

const ready = {
  database: { isReady: async () => true },
  migration: { isReady: async () => true },
  redis: { isReady: async () => true },
  index: { isReady: async () => true },
  model: { isReady: async () => true }
};

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

  it('reports absent readiness adapters as unconfigured rather than unavailable', async () => {
    const app = await createApiApplication({ environment: validEnvironment });
    await app.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`${addressOf(app)}/api/health/ready`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        status: 'unconfigured',
        checks: {
          database: 'unconfigured',
          migration: 'unconfigured',
          redis: 'unconfigured',
          index: 'unconfigured',
          model: 'unconfigured'
        },
        detail: { code: 'CHECKS_UNCONFIGURED', generation: 'disabled' }
      });
    } finally {
      await app.close();
    }
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
