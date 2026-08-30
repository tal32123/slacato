# Railway deployment

Five services in one Railway project. Only **web** gets a public domain; the API
is reachable exclusively over Railway's private network.

## Why the frontend and backend share one origin

`apps/web/src/api/client.ts` requests relative `/api/...` paths with
`credentials: 'include'`, and `apps/api/src/modules/auth/auth.service.ts` issues
`__Host-` prefixed cookies with `sameSite: 'lax'`. A `Lax` cookie is not sent on
cross-origin XHR, and the `__Host-` prefix forbids a `Domain` attribute, so a
split `web.example.com` / `api.example.com` topology cannot authenticate. The web
service therefore runs Caddy, which serves the built SPA and reverse-proxies
`/api/*` to the API. The browser only ever sees one origin.

## Services

| Service | Source | Public domain | Notes |
|---|---|---|---|
| `postgres` | image `pgvector/pgvector:0.8.1-pg17` | no | Volume at `/var/lib/postgresql/data`. `drizzle/0000_initial.sql` runs `CREATE EXTENSION vector`, so stock Postgres is not sufficient. |
| `redis` | image `redis:7.4.2-alpine` | no | Needs `--maxmemory-policy noeviction`; BullMQ silently drops jobs under an eviction policy. `create-service` takes no command, so set it afterwards via `update-service` `startCommand` (see below). Volume at `/data`. |
| `api` | repo `tal32123/slacato`, `Dockerfile` | no | Root directory is the repo root — `workspace:*` deps do not resolve from `apps/api`. |
| `worker` | repo `tal32123/slacato`, `Dockerfile` | no | Same image; start command differs. Without it, briefs queue forever. |
| `web` | repo `tal32123/slacato`, `Dockerfile.web` | **yes** | Caddy static + `/api` proxy. |

## Service configuration

**api**
- Dockerfile path: `Dockerfile`
- Start command: `pnpm --filter @slacato/api start` (that script sets
  `SLACATO_BOOTSTRAP=1`; without it `main.ts` never calls `bootstrap()` and the
  process exits silently)
- Pre-deploy: `pnpm db:migrate` **only**.

  Railway does not honour shell chaining in `preDeployCommand`. A value of
  `pnpm db:migrate && pnpm ingest:records && pnpm index:embeddings` runs the
  migration, reports the deployment as SUCCESS, and **silently skips the rest** —
  no ingestion output appears in the deploy logs and the database is left empty.
  This is not visible from deployment status; the only signal is
  `/api/health/ready` reporting `"index":"unavailable"`. Keep pre-deploy to the
  single migration command and seed as a one-off (below).
- Healthcheck path: `/api/health/live` — **not** `/api/health/ready`, which
  returns 503 until Postgres, Redis, and the model provider are all reachable and
  can deadlock a first deploy.

**worker**
- Dockerfile path: `Dockerfile`
- Start command: `pnpm --filter @slacato/worker start`
- No healthcheck, no domain.

**web**
- Dockerfile path: `Dockerfile.web`
- Generate a Railway domain; this origin is the app's public URL.

**redis** — `create-service` accepts an image but no command, so apply the
persistence and eviction flags in a second step:
```
startCommand: redis-server --appendonly yes --appendfsync everysec \
  --maxmemory 256mb --maxmemory-policy noeviction
```

## Variables

`packages/infrastructure/src/config/env.ts` is a **strict discriminated union**.
With `AI_PROVIDER=openrouter`, setting any `OLLAMA_*` key fails validation at
boot. `parseEnv` filters to a known key list, so Railway's own `PORT` and
`RAILWAY_*` variables are ignored safely.

**api** and **worker**
These are raw Docker images, not Railway's managed Postgres/Redis templates, so
they publish **no** `DATABASE_URL` or `REDIS_URL` reference variable. Build the
URLs explicitly; `${{<service>.VAR}}` is keyed on the actual service name, so
confirm the names `create-service` assigned before using them.

```
NODE_ENV=production
DATABASE_URL=postgresql://slacato:${{postgres.POSTGRES_PASSWORD}}@postgres.railway.internal:5432/slacato
REDIS_URL=redis://redis.railway.internal:6379
WEB_ORIGIN=https://<web-domain>        # exact origin, no trailing path
SESSION_SECRET=<fresh random, >=32 chars>
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=<key>
OPENROUTER_CHAT_MODEL=google/gemini-3.5-flash-lite
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
LOG_LEVEL=info
```
`api` additionally sets `PORT=3000` so the proxy upstream is predictable.

**web**
```
API_UPSTREAM=api.railway.internal:3000
```

Set variables with `skipDeploys: true` while wiring references, then redeploy once.

## Seeding (one-off)

Fixture ingestion and embedding indexing are one-off steps, not pre-deploy steps.
Postgres has no public endpoint, so open a temporary TCP proxy on the `postgres`
service (application port 5432), run the two commands locally against it, then
**delete the proxy**:

```bash
set -a; source .env; set +a
export DATABASE_URL="postgresql://slacato:<password>@<proxy-host>:<proxy-port>/slacato"
pnpm ingest:records      # -> {"totalDocuments":74,"totalChunks":137}
pnpm index:embeddings    # -> {"indexed":137,"skipped":0,"batches":5}
```

Both are idempotent. Re-run `index:embeddings` after any change of
`AI_PROVIDER` or embedding model — the readiness probe requires every
`evidence_versions` row to carry an embedding matching the *currently
configured* provider and model, and exactly one embedding profile across the
table.

## Order of operations

1. Create `postgres` and `redis` with their volumes; wait for both to be healthy.
2. Create `api` and `worker` from the repo, set their variables, set `PORT=3000`
   on `api`.
3. Create `web`, generate its domain.
4. Set `WEB_ORIGIN` on `api` and `worker` to that domain, and `API_UPSTREAM` on
   `web`. Redeploy `api`, `worker`, and `web`.
5. Seed the database (see above).
6. Verify: `GET https://<web-domain>/api/health/ready` returns `200 {"status":"ready"}`.

The Caddy -> `api.railway.internal:3000` hop is the one link not exercised
locally: Railway's private network is IPv6-only, and the local smoke test proxied
to an IPv4 address. If `/api/*` returns 502 on first deploy, check name
resolution there first.

## Notes

- Embeddings are provider-specific. Indexing under `mock` and serving under
  `openrouter` (or the reverse) requires a re-run of `pnpm index:embeddings`.
- `SESSION_SECRET` should be generated fresh rather than reused from local `.env`.


## Deployed instance

Project `slacato` (`0c4e1716-9833-407e-8f67-ada276e864cc`), environment
`production` (`82dd6cbe-c64b-4056-a986-de56c8191b37`).

| Service | ID |
|---|---|
| postgres | `a1da2444-13a6-4d40-8847-ffc6ba315a21` |
| redis | `c779a921-8e39-4461-bb41-c7381775fdf6` |
| api | `efce6da0-9583-4027-a437-2634bff6c1bb` |
| worker | `10f118e1-e3fc-44b7-89d9-f00fde9ef27f` |
| web | `b5f9b9bb-1d1b-4e89-9422-6c53b35ae83f` |

Public URL: <https://web-production-987e.up.railway.app>

Verified end to end: `/` and client-side routes serve the SPA, `/api/*` proxies
to the API over Railway's IPv6 private network, `/api/health/ready` reports all
five checks ready, and a full CSRF -> persona login -> `/api/deals` flow returns
persona-scoped data with `__Host-` cookies set over TLS.
