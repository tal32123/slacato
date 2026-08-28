import { describe, expect, it } from 'vitest';
import { envSchema } from '@slacato/infrastructure/config/env';

describe('envSchema', () => {
  it('rejects a configuration without server secrets', () => {
    expect(() => envSchema.parse({ NODE_ENV: 'test' })).toThrow();
  });
});
