import { describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/main';
import { createWorkerApplication } from '../../apps/worker/src/main';

describe('server composition roots', () => {
  it('rejects API startup before Nest creates an application when required secrets are missing', async () => {
    await expect(createApiApplication({ environment: { NODE_ENV: 'test' } })).rejects.toThrow();
  });

  it('rejects worker startup before Nest creates a long-lived worker when required secrets are missing', async () => {
    await expect(createWorkerApplication({ environment: { NODE_ENV: 'test' } })).rejects.toThrow();
  });
});
