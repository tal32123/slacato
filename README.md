# Strategic Deal Intelligence Assistant

This pnpm monorepo builds a negotiation-preparation brief for a seller from synthetic Salesforce, Gong, pricing, policy, and Slack-style account-team data. A durable multi-agent workflow retrieves only evidence the requester may access, asks specialist agents to analyze it, synthesizes a nine-section deal brief, validates every factual claim against its citations, and routes sensitive recommendations for human approval before finalization.

> [!IMPORTANT]
> **Load `.env` into the shell before running tests or starting the app.** Most of this repo's scripts and test files read `process.env.DATABASE_URL` (and other settings such as the provider, session secret, and web origin) directly, and pnpm does not load `.env` for them automatically:
>
> ```bash
> set -a
> source .env
> set +a
> ```
>
> `drizzle.config.ts` loads `.env` itself (via Node's built-in `process.loadEnvFile`), so `pnpm db:generate` and `pnpm db:migrate` no longer need this step, and — instead of silently falling back to a plausible-but-wrong database and lagging behind the schema other commands expect — now fail immediately with a clear error if `DATABASE_URL` is unset everywhere. Everything else (`pnpm dev`, `pnpm test`, `pnpm ingest:records`, `pnpm index:embeddings`) still needs the shell sourced first.

## Technical overview

Open the self-contained [technical overview](docs/technical-overview.html) for the architecture, agent roles, request lifecycle, design rationale, security notes, Slack-fixture provenance, and production-readiness assessment. It has no external assets and works offline.

## Prerequisites

- Node.js 22.23.1 or newer
- pnpm 10.25.0 (the version pinned by `packageManager`)
- Docker with Docker Compose
- A POSIX-like shell for the environment-loading commands below
- For live inference: an OpenRouter or Ollama API key and explicit chat/embedding model IDs

## Setup

1. Install dependencies.

   ```bash
   corepack enable
   pnpm install --frozen-lockfile
   ```

2. Start PostgreSQL with pgvector on `127.0.0.1:54329` and Redis on `127.0.0.1:56379`.

   ```bash
   docker compose up -d
   docker compose ps
   ```

3. Create and edit the local environment file, then export it into the current shell. At minimum, replace `SESSION_SECRET`; select and configure the model provider before indexing.

   ```bash
   cp .env.example .env
   $EDITOR .env
   set -a
   source .env
   set +a
   ```

4. Apply the Drizzle migrations.

   ```bash
   pnpm db:migrate
   ```

5. Ingest the checked-in synthetic fixtures. This is idempotent and includes Salesforce, Gong, pricing, policy, permissions, and the generated Slack-style updates.

   ```bash
   pnpm ingest:records
   ```

6. Build embeddings with the same provider/profile that the runtime will use.

   ```bash
   pnpm index:embeddings
   ```

   Changing the embedding model, dimension, or normalization profile requires re-embedding; the retriever rejects cross-profile comparisons. The default OpenRouter embedding model uses 1,536 dimensions. A custom OpenRouter embedding model also requires the indexing-only `OPENROUTER_EMBEDDING_DIMENSION` setting.

## Run the application

After sourcing `.env`, start the React app, NestJS API, and worker together:

```bash
pnpm dev
```

The API listens on `http://127.0.0.1:3000`. Vite prints the web URL (normally `http://127.0.0.1:5173`). Set `WEB_ORIGIN` to the exact browser origin you use; for the Playwright configuration that origin is `http://127.0.0.1:4173`.

To generate a brief through the supported browser flow:

1. Open the web URL and select a demo persona.
2. Open a deal the persona is authorized to view.
3. Choose **Generate brief**. The UI follows the run through retrieval, specialist analysis, synthesis, validation, approval, and finalization.
4. If the run enters `awaiting_approval`, switch to an eligible approval persona and decide each required approval entry. A discount above 15% needs distinct deal-desk and sales-leader approvals.

The underlying authenticated endpoint is `POST /api/runs/deal-brief` with `{ "opportunityId": "...", "idempotencyKey": "..." }`. Browser requests also require the persona session and CSRF flow, so the UI is the simplest reviewer path.

## Test and verify

Keep PostgreSQL and Redis running and source `.env` in the same shell first.

```bash
pnpm test                 # unit, contract, and integration tests
pnpm test:integration     # integration suite only
pnpm test:e2e             # Playwright; builds and starts its own app servers
pnpm typecheck
pnpm lint
pnpm build
```

> [!WARNING]
> **Stop any app server on port 3000 before running `pnpm test:e2e`.** Playwright is configured with `reuseExistingServer` outside CI, so if anything is already listening on `:3000` it silently tests against *that* server instead of starting its own with persona bootstrapping enabled. The symptom is misleading: every login-dependent test fails on `/login?returnTo=…` rather than reporting a port conflict. Check with `lsof -nP -iTCP:3000 -sTCP:LISTEN` and stop the process first.

Two evaluations run alongside the test suites. Both are wired into CI.

```bash
pnpm eval:deterministic    # golden-retrieval recall and permission leakage
pnpm eval:brief-quality    # brief-quality invariants over samples/*.json
```

`eval:deterministic` runs `evals/golden-retrieval.json` against a throwaway database it creates and
drops: 18 scored cases carrying 56 hand-checked relevance labels, plus 5 cases that must return
nothing at all because the requester is unauthorized. Cases may also carry `forbiddenEvidenceIds` -
evidence a specific reader must never be handed, such as a sensitive-pricing note for a persona
without that grant, or a source family outside their authorized set. Returning one counts as
permission leakage exactly like answering a denied request. `evals/reports/retrieval.json` is the
checked-in output, per case, so every number below is reproducible.

**The retrieval quality gate is currently red, and that is reported rather than tuned away.**
Permission leakage is 0 across all 23 cases, including the ones carrying `forbiddenEvidenceIds`.
But macro recall@5 is 0.222 and macro precision@5 is 0.133, against a 0.5 recall floor. The earlier
three-case set scored 0.5 only because its six labels happened to be the lexically obvious Slack
rows; it was too coarse to move, which is why the per-source candidate windows in
`packages/core/src/application/evidence/retriever.ts` could be tuned with the note that no value
between 1 and 7 regressed it.

The defect is **ranking order, not blindness**. Re-running the same labels at `limit: 20` - the
limit the product actually uses - gives macro recall@20 of 0.75, so three quarters of the labelled
evidence is found; it just lands too far down the list. Gong transcripts are the clearest case:
they never once reach the top 5, and cluster at ranks 10-20 in every case. The top 5 instead holds
a near-fixed shape per opportunity - the two most recent Slack rows, a pricing note, one CRM
contact, one policy chunk - largely regardless of what was asked. Two causes are visible in the
code: the ranked hybrid fuses the caller's query with six fixed section queries, so their own words
carry roughly a seventh of the fusion mass, and only one policy chunk is ever admitted to the
ranked selection, chosen without regard to the query (three cases miss a policy label they name
almost verbatim). That shape is defensible for assembling a standard evidence pack for a brief and
poor at answering a specific question, and the eval now says so out loud.

The floor stays at the value it was calibrated to, and the cases stay at `limit: 5` for the same
reason. Raising the limit to 20 would turn this gate green today without changing the retriever,
which is the wrong way to close it.

`eval:brief-quality` measures whether a produced brief is usable by the reviewer who reads it:
that no cited stakeholder is silently dropped, that citations span more than one source family,
that the required sections are populated, that no internal identifier appears in user-facing copy,
and that no warning contradicts the brief around it. The rules themselves are unit tested in
`tests/unit/brief-quality.test.ts`, and `tests/unit/brief-grounding.test.ts` holds the same
invariants against the real validation pass with no model and no database.

A live-LLM tier runs the same invariants against a brief a real provider produces, travelling the
full production workflow against a database it creates and drops. It spends real tokens, so it is
opt-in and never part of CI:

```bash
BRIEF_QUALITY_LIVE=1 AI_PROVIDER=openrouter OPENROUTER_API_KEY=... pnpm eval:brief-quality:live
```

## Model providers and environment

All runtime secrets are server-side environment variables. `.env` and `.env.local` are gitignored.

| Provider | Use | Required provider settings |
| --- | --- | --- |
| `mock` | Deterministic local development and tests only. It uses a 64-dimensional token-hash embedding and no network or key. Do not use it to create submission or demo artifacts. | `AI_PROVIDER=mock` |
| `openrouter` | Live structured generation and embeddings through OpenRouter. | `AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, `OPENROUTER_CHAT_MODEL`, `OPENROUTER_EMBEDDING_MODEL` |
| `ollama` | Live Ollama-compatible generation and embeddings; the adapter probes embedding dimension/normalization and structured-output capability. | `AI_PROVIDER=ollama`, `OLLAMA_API_KEY`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBEDDING_MODEL`; `OLLAMA_BASE_URL` defaults to `https://ollama.com/api` |

The full configuration surface represented by `.env.example` is:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production` runtime mode |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis/BullMQ connection string |
| `WEB_ORIGIN` | Exact allowed browser origin, with no path |
| `SESSION_SECRET` | Server-side session signing secret, at least 32 characters |
| `AI_PROVIDER` | `mock`, `openrouter`, or `ollama` |
| `OPENROUTER_API_KEY` | OpenRouter server-side credential |
| `OPENROUTER_CHAT_MODEL` | OpenRouter chat model ID |
| `OPENROUTER_EMBEDDING_MODEL` | OpenRouter embedding model ID |
| `OLLAMA_API_KEY` | Ollama server-side credential |
| `OLLAMA_BASE_URL` | Ollama API base URL |
| `OLLAMA_CHAT_MODEL` | Ollama chat model ID |
| `OLLAMA_EMBEDDING_MODEL` | Ollama embedding model ID |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |

Generation uses schema-constrained output where the provider supports it, disables provider-library retries, and applies bounded calls, transport retries, schema repairs, output tokens, and deadlines in the shared model gateway. OpenRouter is configured to allow provider failover while requiring requested parameters. The checked-in Slack fixture provenance records a completed live OpenRouter run with `google/gemini-3.5-flash-lite`, native-schema output, two calls, and 5,825 total tokens; see `fixtures/cato/slack/generation.json`.

If you intentionally regenerate the Slack fixtures, use a live provider only:

```bash
pnpm fixtures:slack
pnpm ingest:records
pnpm index:embeddings
```

That command rejects `AI_PROVIDER=mock` and replaces the checked-in fixture and its provenance manifest only after schema, chronology, synthetic-notice, coverage, hash, and positive provider-usage checks pass.
