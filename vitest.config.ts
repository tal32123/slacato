import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: [
    { find: '@slacato/contracts', replacement: fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)) },
    { find: '@slacato/core', replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)) },
    { find: /^@slacato\/infrastructure\/(.+)$/, replacement: fileURLToPath(new URL('./packages/infrastructure/src/$1.ts', import.meta.url)) },
    { find: '@slacato/infrastructure', replacement: fileURLToPath(new URL('./packages/infrastructure/src/index.ts', import.meta.url)) },
    { find: '@slacato/api', replacement: fileURLToPath(new URL('./apps/api/src', import.meta.url)) },
    { find: '@slacato/web', replacement: fileURLToPath(new URL('./apps/web/src', import.meta.url)) }
  ] },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
});
