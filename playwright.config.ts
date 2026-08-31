import { defineConfig } from '@playwright/test';

// The API port defaults to 3000 to match CI and every hardcoded `Origin: http://127.0.0.1:4173`
// header in the existing specs (the web dev server stays on 4173 unconditionally; only the API's
// *internal* port is overridable). Set E2E_API_PORT when 3000 is occupied by an unrelated local
// process so this suite never fights another session for the port.
const apiPort = process.env.E2E_API_PORT ?? '3000';

// Reusing a pre-existing server is only safe when we know what port configuration it was started
// with. A stale web dev server left running from a PREVIOUS local run may have its Vite proxy
// wired to a different API port than this run's `apiPort` (e.g. one run used the default :3000,
// the next set E2E_API_PORT=3101 because :3000 was occupied) -- reusing it would silently send
// every /api call to the wrong API instance. So whenever E2E_API_PORT is set explicitly, treat
// this as an isolated run and never reuse anything, regardless of CI; only fall back to the
// original CI-gated reuse behavior when no override is requested.
const reuseExistingServer = !process.env.CI && process.env.E2E_API_PORT === undefined;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: [
    {
      command: `DATABASE_URL=\${DATABASE_URL:-postgres://slacato:slacato@127.0.0.1:54329/slacato} pnpm db:migrate && DATABASE_URL=\${DATABASE_URL:-postgres://slacato:slacato@127.0.0.1:54329/slacato} pnpm ingest:records && pnpm build && DATABASE_URL=\${DATABASE_URL:-postgres://slacato:slacato@127.0.0.1:54329/slacato} SESSION_SECRET=playwright-session-secret-that-is-long-enough AI_PROVIDER=mock WEB_ORIGIN=http://127.0.0.1:4173 SLACATO_BOOTSTRAP=1 PORT=${apiPort} node apps/api/dist/main.js`,
      url: `http://127.0.0.1:${apiPort}/api/health/live`,
      reuseExistingServer,
      timeout: 120_000
    },
    {
      command: `E2E_API_PORT=${apiPort} pnpm --filter @slacato/web dev --host 127.0.0.1 --port 4173`,
      url: 'http://127.0.0.1:4173',
      reuseExistingServer,
      timeout: 120_000
    }
  ]
});
