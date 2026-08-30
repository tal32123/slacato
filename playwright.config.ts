import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: [
    {
      command: "DATABASE_URL=${DATABASE_URL:-postgres://slacato:slacato@127.0.0.1:54329/slacato} pnpm db:migrate && DATABASE_URL=${DATABASE_URL:-postgres://slacato:slacato@127.0.0.1:54329/slacato} pnpm ingest:records && pnpm build && DATABASE_URL=${DATABASE_URL:-postgres://slacato:slacato@127.0.0.1:54329/slacato} SESSION_SECRET=playwright-session-secret-that-is-long-enough AI_PROVIDER=mock WEB_ORIGIN=http://127.0.0.1:4173 SLACATO_BOOTSTRAP=1 node apps/api/dist/main.js",
      url: 'http://127.0.0.1:3000/api/health/live',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    },
    {
      command: 'pnpm --filter @slacato/web dev --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    }
  ]
});
