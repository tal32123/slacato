import { describe, expect, it } from 'vitest';
import { HealthController } from '../../apps/api/src/modules/health/health.controller';
import { HealthService } from '../../apps/api/src/modules/health/health.service';

const ready = {
  database: { isReady: async () => true },
  redis: { isReady: async () => true },
  index: { isReady: async () => true },
  model: { isReady: async () => true }
};

describe('HealthController', () => {
  it('reports process liveness without external dependencies', async () => {
    await expect(new HealthController(new HealthService(ready)).live()).resolves.toEqual({ status: 'live' });
  });

  it('reports a typed non-ready dependency without throwing or restarting', async () => {
    const service = new HealthService({ ...ready, model: { isReady: async () => false } });
    await expect(new HealthController(service).ready()).resolves.toEqual({
      status: 'not_ready',
      checks: { database: 'ready', redis: 'ready', index: 'ready', model: 'unavailable' },
      detail: { code: 'MODEL_UNAVAILABLE', generation: 'disabled' }
    });
  });
});
