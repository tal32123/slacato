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
- Pre-deploy: `pnpm db:migrate && pnpm ingest:records && pnpm index:embeddings`
  (all idempotent)
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

## Order of operations

1. Create `postgres` and `redis` with their volumes; wait for both to be healthy.
2. Create `api` and `worker` from the repo, set their variables, set `PORT=3000`
   on `api`.
3. Create `web`, generate its domain.
4. Set `WEB_ORIGIN` on `api` and `worker` to that domain, and `API_UPSTREAM` on
   `web`. Redeploy `api`, `worker`, and `web`.
5. Verify: `GET https://<web-domain>/api/health/ready` returns `200 {"status":"ready"}`.

The Caddy -> `api.railway.internal:3000` hop is the one link not exercised
locally: Railway's private network is IPv6-only, and the local smoke test proxied
to an IPv4 address. If `/api/*` returns 502 on first deploy, check name
resolution there first.

## Notes

- Embeddings are provider-specific. Indexing under `mock` and serving under
  `openrouter` (or the reverse) requires a re-run of `pnpm index:embeddings`.
- `SESSION_SECRET` should be generated fresh rather than reused from local `.env`.
