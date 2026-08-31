import { defineConfig } from '@playwright/test';

// The API port defaults to 3000 to match CI and every hardcoded `Origin: http://127.0.0.1:4173`
// header in the existing specs (the web dev server stays on 4173 unconditionally; only the API's
// *internal* port is overridable). Set E2E_API_PORT when 3000 is occupied by an unrelated local
// process so this suite never fights another session for the port.
const apiPort = process.env.E2E_API_PORT ?? '3000';

// Defaults to a database DISTINCT from .env.example's own default
// (postgres://slacato:slacato@127.0.0.1:54329/slacato), which is also the one database
// docker-compose.yml provisions with a persistent named volume. Before this, a local e2e run and
// a local `pnpm dev` session shared that exact connection string, so e2e's fixture rows -- many of
// them permanently undeletable (approval_requirement_entries' rows are immutable by trigger) --
// accumulated straight into the database a developer's manual demo/review session reads from.
// This reproduces on a fresh clone; it is not specific to this shared environment. CI is
// unaffected: it sets DATABASE_URL explicitly to its own ephemeral per-job Postgres service, so
// this fallback is never reached there.
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato_e2e';
// Fill in the environment for this process (and anything it spawns) so that the existing specs'
// own `process.env.DATABASE_URL ?? 'postgres://.../slacato'` fallbacks -- which this config file
// cannot rewrite -- resolve to the SAME database as the API server below, rather than quietly
// reading/writing the old shared default while the server they're driving talks to the new one.
process.env.DATABASE_URL = databaseUrl;

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
      // Embeddings must be indexed with the same AI_PROVIDER the server below runs with (mock),
      // or /api/health/ready reports the evidence index unavailable and the UI's generation
      // readiness gate correctly refuses to enable "Generate Brief" -- see
      // apps/web/src/features/runs/generation-readiness.ts.
      command: `DATABASE_URL=${databaseUrl} pnpm db:ensure && DATABASE_URL=${databaseUrl} pnpm db:migrate && DATABASE_URL=${databaseUrl} pnpm ingest:records && DATABASE_URL=${databaseUrl} AI_PROVIDER=mock pnpm index:embeddings && pnpm build && DATABASE_URL=${databaseUrl} SESSION_SECRET=playwright-session-secret-that-is-long-enough AI_PROVIDER=mock WEB_ORIGIN=http://127.0.0.1:4173 SLACATO_BOOTSTRAP=1 PORT=${apiPort} node apps/api/dist/main.js`,
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
