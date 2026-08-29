# SlaCato Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-quality, responsive strategic deal-intelligence application that satisfies every Cato home-task requirement with live Ollama Cloud agents, authorized hybrid RAG, durable approvals, and evidence-backed briefs.

**Architecture:** Build a TypeScript workspace with a React/Vite SPA, a NestJS HTTP API, and a separate NestJS BullMQ worker. A persisted `DealBriefWorkflow` coordinates four specialist agents through provider-neutral ports. PostgreSQL with pgvector is the business system of record; a transactional outbox publishes idempotent jobs to Redis/BullMQ. Drizzle adapters, authorization-scoped hybrid retrieval, and generic AI, queue, context, and SSE boundaries keep infrastructure independent of sales logic.

**Tech Stack:** TypeScript, Node 22.23.1, pnpm 10.25.0, React 19.2.8, Vite 8.2.2, React Router 8.3.0, TanStack Query 5.102.8, NestJS 12.0.1, BullMQ 6.3.1, Redis, Tailwind CSS, shadcn/ui with Radix, Vercel AI SDK 7.0.83, `ollama-ai-provider-v2` 4.0.1, Zod 4.4.3, PostgreSQL, pgvector, Drizzle ORM 0.45.2/Kit 0.31.10, Pino, Vitest, Testing Library, Playwright, axe-core, Promptfoo, Docker Compose, Railway.

**Spec:** `docs/superpowers/specs/2026-08-28-slacato-design.md`

## Global Constraints

- Application name is `SlaCato`; package name is `slacato`.
- Use strict TypeScript without `any`; prefer `unknown` plus validation at external boundaries.
- Use React/Vite for presentation and NestJS controllers for REST, SSE, health, session, and export endpoints. Keep controllers thin and return shared, Zod-validated contracts.
- Use shadcn `new-york` components with Radix, Geist, Tailwind theme tokens, and the approved Cato palette: `#182D2A`, `#0D483D`, `#158864`, `#81E5AC`, `#DEF6EF`, `#F6F6F6`, `#F5C13D`.
- Slack influences collaboration patterns only; do not copy Slack marks or trade dress.
- Enforce authorization before retrieval, prompting, citation resolution, logging, and rendering; unauthorized responses reveal no hidden counts or metadata.
- Persist run IDs before model calls and persist every attempt, usage record, validated artifact, checkpoint, approval, and final brief.
- Default deterministic tests and local development to the mock provider; provider and transport modules contain no Cato or sales rules. Reviewer runs, the interview demo, and submitted generated artifacts MUST use live Ollama Cloud after its server-only credentialed probe succeeds. Mock output is never accepted as assignment evidence.
- Stream safe workflow progress and completed validated sections over SSE; never stream or store raw chain of thought.
- Embedding model is deployment configuration and cannot be changed in the UI.
- Part 1 uses PostgreSQL FTS, exact cosine over the authorized pgvector subset, and RRF; HNSW, pg_trgm, and cross-encoder reranking remain deferred until baseline metrics justify them.
- Docker Compose with `web`, `api`, `worker`, `db`, and `redis` is the local deployment; Railway is the production reference. Vercel Workflow and Eve are intentionally not used.
- Keep PostgreSQL authoritative for business workflow state. BullMQ transports short idempotent commands; human approval persists `awaiting_approval` and ends the current job rather than parking a worker.
- Enforce a provider-neutral context budget before every model call and bound retrieval/tool payloads first. Keep the already-built `ContextCompactor` dormant for possible future multi-turn activation; initial-release workflows and submission acceptance do not invoke or depend on it.
- Runtime provider/model selection, theme preferences, and audit-visibility preferences are out of scope. Persona switching remains; model/index/permission information is read-only Demo Diagnostics.
- Use TDD, focused modules, rationale-oriented JSDoc for public contracts, structured redacted logs, and frequent task-level commits.
- Canonical fixture source is branch `home-task`, commit `076c659c3c7afd416f8d26729774b67042a55761` of `https://github.com/danaabramov/Cato-IS-AI-Engineer-Exam.git`.

## File and Module Map

```text
apps/
  web/src/
    routes/{login,deals,deal,runs,run,approvals,settings,diagnostics}.tsx
    components/{app-shell,mobile-nav,persona-menu,status-badge}.tsx
    components/ui/*
    api/{client,queries,mutations,sse}.ts
    styles/globals.css
  api/src/
    main.ts app.module.ts
    modules/{auth,deals,runs,approvals,exports,health}/*
  worker/src/
    main.ts worker.module.ts processors/deal-brief.processor.ts
packages/
  contracts/src/{auth,deals,runs,approvals,briefs,events}.ts
  core/src/
    domain/{briefs,runs,approvals,permissions}/*
    application/{agents,briefs,evidence,model,context}/*
  infrastructure/src/
    db/{client,schema,relations,repositories}/*
    queue/{bullmq,outbox-dispatcher}.ts
    model/{ollama,capabilities}.ts
    retrieval/postgres-retriever.ts
    events/postgres-event-store.ts
    logging/{logger,redaction}.ts
scripts/{fetch-fixtures,generate-slack-fixtures,ingest,evaluate}.ts
fixtures/cato/**
drizzle/**
evals/{promptfooconfig.yaml,golden-retrieval.json,security-cases.json}
tests/{unit,integration,contract,e2e}/**
```

## Binding Execution Order and Review Decisions

Task numbers below remain stable references, but execution MUST follow this dependency order: **1 → 2 → 7 → 3 → 4 → 5 → 6 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17**. Task 7's mock profile enables deterministic tests and local development only; reviewer/demo/submission work requires the live gate. Task 3 must use a dimension-flexible vector column and persist profile metadata rather than pinning its typmod to mock or unverified live dimensions. Task 4 ingests records only and Task 6 creates embeddings/indexes.

The architecture, AI/RAG, and UI/UX reviews resolved these choices: NestJS plus BullMQ and a PostgreSQL transactional outbox instead of in-request work or a general workflow platform; exact authorized vector search instead of HNSW; capability-aware native schema or prompted-JSON generation; immutable versioned approval subjects; provider-neutral context budgeting; read-only diagnostics instead of model/theme controls; and mandatory live artifacts before packaging.

## Assignment Traceability Closeout

Tasks already completed keep their original implementation history. The following assignment gates are normative for remaining implementation and closeout verification; Task 15 adds regression proof for completed foundations instead of rewriting their history.

| Requirement ID | Concrete acceptance evidence | Owning tasks |
|---|---|---|
| `ASG-PROD-01` | Product copy, README, and timed presentation state seller-assist/no autonomous customer action. | 11, 17 |
| `ASG-DATA-01` | Sanitized `source-coverage.json` proves each of eight provided groups across inventory → authorized retrieval/control → intended agent receipt → resulting claim/section/citation, with access permissions explicitly authorization-only; any missing stage fails. | 4, 6, 8, 10, 15, 16 |
| `ASG-SLACK-01` | Submission Slack is regenerated with live Ollama, records real provider/model/usage/provenance and row-level categories, is reviewed/reingested/reindexed, passes PII/novelty/authorization checks, and yields a stable citation plus with/without-Slack brief diff. | 4, 5, 6, 15, 16 |
| `ASG-LIVE-01` | Non-mock provider markers, four nonzero-usage agent invocations, live approval output, and live traces for mandatory scenarios. | 7, 8, 9, 16 |
| `ASG-AUTH-01` | Pre-retrieval/pre-generation denial tests plus distinct safe `authorization_lookup` and `evidence_retrieval` trace kinds. | 5, 6, 8, 10, 15 |
| `ASG-CITE-01` | Claim resolver and UI/export tests render `source=<path>, <stable key>=<stable ID>` and reject unauthorized/stale IDs. | 6, 8, 12, 14, 15 |
| `ASG-HITL-01` | Deterministic category matrix, distinct authority grants, multi-actor quorum, immutable subject/CAS, low-confidence and customer-language gates. | 5, 9, 13, 15 |
| `ASG-AGENT-01` | Four typed LLM-backed contracts with no tools, validation, trace, and per-agent degraded/fatal failure tests. | 7, 8, 9, 10, 15 |
| `ASG-GUARD-01` | Unsupported/restricted/injected/unsafe output is blocked; low confidence, conflict, missing evidence, and customer language route to required review. | 8, 9, 15 |
| `ASG-TRACE-01` | Trace completeness checker links authorization, retrieval, all attempts, validation/repair, guardrails, approvals, recommendations, usage, and finalization. | 3, 7, 9, 10, 14, 15 |
| `ASG-DEMO-01` | E2E passes authorized standard, authorized restricted/quorum, opaque denial, malformed input, missing data, partial failure, and visible Slack-impact scenarios. | 9, 12, 13, 15, 16 |
| `ASG-DOC-01` | Runnable prototype, two explicit diagrams, technical overview, security notes, sample artifacts, and a timed presentation deck/script. | 16, 17 |
| `ASG-PROVIDER-01` | `.env.example`, compatibility probe, exact Ollama model/parameters/secrets/run commands, and verifier rejection of mock artifacts. | 1, 7, 16, 17 |

The Part 1 baseline is PostgreSQL FTS plus bi-encoder embeddings, exact authorized-subset cosine search, and RRF. Cross-encoder reranking is optional only after baseline evaluation and discussion. Do not claim the bonus cost-aware router, cross-encoder, or additional synthetic-data generator unless separately implemented, measured, and accepted.

---

### Task 1: Scaffold the Quality-Gated TypeScript Workspace

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `.env.example`, `apps/web/**`, `apps/api/**`, `apps/worker/**`, `packages/contracts/**`, `packages/core/**`, `packages/infrastructure/src/config/env.ts`, `tests/unit/env.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: validated `Env`, NestJS liveness/readiness controllers, shared API contracts, `cn(...inputs: ClassValue[]): string`.

- [ ] **Step 1: Scaffold and install only the agreed foundations**

Run:

```bash
pnpm create vite apps/web --template react-ts
pnpm dlx @nestjs/cli@12 new apps/api --package-manager pnpm --skip-git
pnpm --dir apps/web dlx shadcn@latest init -d --base radix
pnpm --filter @slacato/core add ai@7.0.83 zod@4.4.3 nanoid
pnpm --filter @slacato/infrastructure add ollama-ai-provider-v2@4.0.1 drizzle-orm@0.45.2 postgres@3.4.9 pgvector pino bullmq@6.3.1 ioredis
pnpm --filter @slacato/api add @nestjs/bullmq@12.0.0
pnpm --filter @slacato/worker add @nestjs/bullmq@12.0.0
pnpm --filter @slacato/web add react-router@8.3.0 @tanstack/react-query@5.102.8
pnpm add -Dw drizzle-kit@0.31.10 vitest @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom jsdom @playwright/test @axe-core/playwright tsx promptfoo eslint-plugin-boundaries
pnpm --dir apps/web dlx shadcn@latest add button card badge table tabs select sheet dialog alert-dialog alert avatar dropdown-menu scroll-area separator skeleton tooltip progress textarea label input
```

Expected: the web, API, worker, and package workspace boundaries compile; shadcn is non-interactive and Radix-based; and `pnpm-lock.yaml` pins the resolved versions. Before package-scoped installs, create and name all workspace manifests (`@slacato/web`, `@slacato/api`, `@slacato/worker`, `@slacato/contracts`, `@slacato/core`, `@slacato/infrastructure`). Create the worker as a second Nest bootstrap over shared application/infrastructure packages rather than duplicating domain code.

- [ ] **Step 2: Write the failing environment contract test**

```ts
import { describe, expect, it } from 'vitest';
import { envSchema, parseEnv } from '@slacato/infrastructure/config/env';

describe('envSchema', () => {
  const common = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54329/slacato',
    SESSION_SECRET: 'x'.repeat(32),
  } as const;

  it('accepts mock without Ollama credentials', () => {
    expect(envSchema.parse({ ...common, AI_PROVIDER: 'mock' }).AI_PROVIDER).toBe('mock');
  });

  it('rejects live Ollama without every required credential/model', () => {
    expect(() => envSchema.parse({ ...common, AI_PROVIDER: 'ollama' })).toThrow();
  });

  it('selects named keys from ordinary process env and requires an exact HTTP(S) origin', () => {
    expect(parseEnv({ ...common, AI_PROVIDER: 'mock', PATH: '/usr/bin' })).toMatchObject({ AI_PROVIDER: 'mock' });
    expect(() => envSchema.parse({ ...common, AI_PROVIDER: 'mock', WEB_ORIGIN: 'https://app.example.test/path' }))
      .toThrow('exact HTTP(S) origin');
  });
});
```

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `pnpm vitest run tests/unit/env.test.ts`  
Expected: FAIL because `src/lib/env.ts` does not exist.

- [ ] **Step 4: Implement validated server-only configuration and scripts**

```ts
import { z } from 'zod';

const exactHttpOrigin = z.string().url().refine(value => {
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && value === url.origin;
}, 'Must be an exact HTTP(S) origin without path, query, or hash');

const commonEnvironment = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:56379'),
  WEB_ORIGIN: exactHttpOrigin.default('http://127.0.0.1:4173'),
  SESSION_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
};

const mockEnvironment = z.object({
  ...commonEnvironment,
  AI_PROVIDER: z.literal('mock'),
  OLLAMA_API_KEY: z.string().min(1).optional(),
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_CHAT_MODEL: z.string().min(1).optional(),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).optional(),
}).strict();

const ollamaEnvironment = z.object({
  ...commonEnvironment,
  AI_PROVIDER: z.literal('ollama'),
  OLLAMA_API_KEY: z.string().min(1),
  OLLAMA_BASE_URL: z.string().url().default('https://ollama.com/api'),
  OLLAMA_CHAT_MODEL: z.string().min(1),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1),
}).strict();

export const envSchema = z.preprocess(input => {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || 'AI_PROVIDER' in input) return input;
  return { ...input, AI_PROVIDER: 'mock' };
}, z.discriminatedUnion('AI_PROVIDER', [mockEnvironment, ollamaEnvironment]));

export type Env = z.infer<typeof envSchema>;

const envKeys = [
  'NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'WEB_ORIGIN', 'SESSION_SECRET', 'LOG_LEVEL', 'AI_PROVIDER',
  'OLLAMA_API_KEY', 'OLLAMA_BASE_URL', 'OLLAMA_CHAT_MODEL', 'OLLAMA_EMBEDDING_MODEL',
] as const;

export const parseEnv = (input: NodeJS.ProcessEnv): Env => envSchema.parse(Object.fromEntries(
  envKeys.flatMap(key => input[key] === undefined ? [] : [[key, input[key]]]),
));
```

Keep `envSchema` and `parseEnv` import-safe for deterministic tests. A separate server-only composition-root module calls `parseEnv(process.env)` at runtime. Implement `/api/health/live` as process liveness and `/api/health/ready` as database/migration/model/index readiness.

Add scripts before first use for `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `db:generate`, `db:migrate`, `fixtures:fetch`, `fixtures:slack`, `ingest:records`, `index:embeddings`, `eval:deterministic`, `eval:live`, `demo:generate-live`, and `verify:live-artifacts`.

Add a NestJS Zod request pipe and response interceptor shared by all controllers. Validate params, queries, request bodies, response payloads, and SSE envelopes at runtime; reject unknown keys, unsupported content types, and oversized bodies with typed safe errors. TypeScript types alone do not define the wire boundary.

- [ ] **Step 5: Apply the verified theme and runtime defaults**

Load Geist locally, map shadcn semantic tokens to the Cato palette, configure Vite SPA fallbacks, enable NestJS graceful shutdown and strict validation, and keep secrets out of the web build. Do not add gradients to foundational surfaces.

- [ ] **Step 6: Verify the foundation**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm build`  
Expected: all commands exit 0; `/api/health/live` reports process liveness and `/api/health/ready` verifies required database migration, Redis, and index readiness. A provider outage disables generation with a typed health detail but does not create an API restart loop.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.mjs vitest.config.ts playwright.config.ts .env.example .gitignore apps packages tests
git commit -m "chore: scaffold SlaCato application"
```

### Task 2: Define Domain IDs, Errors, Brief Schema, and Run State Machine

**Files:**
- Create: `packages/core/src/domain/shared/{ids,errors,result}.ts`, `packages/core/src/domain/briefs/schema.ts`, `packages/core/src/application/agents/contracts.ts`, `packages/core/src/domain/runs/{contracts,state-machine}.ts`, `tests/unit/brief-schema.test.ts`, `tests/unit/run-state-machine.test.ts`

**Interfaces:**
- Produces: branded `UserId`, `AccountId`, `OpportunityId`, `RunId`, `EvidenceId`, `CitationId`; `DealBrief`; all four specialist artifact schemas; `RunStatus`; `transitionRun(status, event): RunStatus`; typed `AppError` hierarchy.

- [ ] **Step 1: Write failing schema and transition tests**

```ts
import { describe, expect, it } from 'vitest';
import { dealBriefSchema } from '@slacato/core/domain/briefs/schema';
import { transitionRun } from '@slacato/core/domain/runs/state-machine';

describe('domain contracts', () => {
  it('requires every assignment section', () => {
    expect(() => dealBriefSchema.parse({ executiveSummary: 'x' })).toThrow();
  });

  it('finalizes an approved snapshot without returning to synthesis', () => {
    expect(transitionRun('awaiting_approval', 'approval_granted')).toBe('finalizing');
    expect(() => transitionRun('created', 'complete')).toThrow();
  });
});
```

- [ ] **Step 2: Run tests and confirm missing modules**

Run: `pnpm vitest run tests/unit/brief-schema.test.ts tests/unit/run-state-machine.test.ts`  
Expected: FAIL with unresolved module errors.

- [ ] **Step 3: Implement immutable Zod domain contracts**

Define the nine brief sections, claim and citation IDs, confidence in `[0,1]`, warnings, stakeholder records, recommended actions, and evidence summaries. Put explicit `.max(...)` bounds on every generated string and array plus a total serialized artifact limit. Define statuses `created`, `retrieving`, `specialists_running`, `synthesizing`, `validating`, `awaiting_approval`, `finalizing`, `completed`, `rejected`, and `failed` with an exhaustive event transition table. `finalizing` performs deterministic revalidation/persistence only and cannot invoke an agent.

```ts
export function transitionRun(status: RunStatus, event: RunEvent): RunStatus {
  const next = transitions[status][event];
  if (!next) throw new InvalidRunTransitionError(status, event);
  return next;
}
```

- [ ] **Step 4: Verify exhaustive typing**

Run: `pnpm typecheck && pnpm vitest run tests/unit/brief-schema.test.ts tests/unit/run-state-machine.test.ts`  
Expected: PASS with no default branch that silently accepts unknown states.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/domain packages/core/src/application/agents/contracts.ts tests/unit
git commit -m "feat: define deal brief domain contracts"
```

### Task 3: Add PostgreSQL, pgvector, BullMQ, Transactional Outbox, and Deep Persistence Ports

**Files:**
- Create: `docker-compose.yml`, `drizzle.config.ts`, `packages/core/src/application/workflow/{command-queue,workflow-store}.ts`, `packages/infrastructure/src/db/{client,schema,relations}.ts`, `packages/infrastructure/src/db/repositories/*.ts`, `packages/infrastructure/src/queue/{bullmq,outbox-dispatcher,reconciler}.ts`, `apps/worker/src/{main,worker.module}.ts`, `drizzle/0000_initial.sql`, `tests/integration/repositories.test.ts`, `tests/integration/outbox-queue.test.ts`

**Interfaces:**
- Produces: deep application seams `WorkflowStore.startRun/claimStep/commitStepAndEnqueueNext/awaitApproval/recordDecisionAndEnqueueFinalization`, `CommandQueue.publish`, plus evidence and retrieval ports. Drizzle, outbox, BullMQ, Redis, and polling types remain infrastructure-private.

- [ ] **Step 1: Write repository contract tests against a disposable database**

```ts
it('persists the run before any generation attempt', async () => {
  const run = await repositories.runs.create({
    id: runId,
    opportunityId,
    requestedBy: userId,
    status: 'created',
    generationModel: 'ollama/test-chat',
  });
  expect(await repositories.runs.get(run.id)).toMatchObject({ status: 'created' });
});
```

- [ ] **Step 2: Define Compose, then start PostgreSQL and Redis and confirm the test fails before migrations**

First create Compose services using a pgvector-capable PostgreSQL image and Redis configured with AOF persistence and `maxmemory-policy=noeviction`. Then run: `docker compose up -d db redis && pnpm test:integration -- repositories.test.ts`  
Expected: FAIL because tables do not exist.

- [ ] **Step 3: Implement schema and migration**

Create the `vector` extension. Add normalized tables for personas, permission grants, accounts, opportunities, contacts, immutable document/evidence versions, immutable run evidence manifests, runs, outbox commands, leased step invocations, checkpoints, generation attempts, context checkpoints, specialist artifacts, claims, citations, approval subjects/decisions, briefs, trace spans, run events, and audit events. Use a dimension-flexible vector column and persist provider/model/dimension/profile metadata; reject mixed-profile comparisons in application invariants. Do not pin a pgvector typmod to the mock profile or an unverified Ollama dimension. Use a generated `tsvector`; exact cosine needs no HNSW index for this fixture-sized corpus. A later real-model activation requires full re-embedding and an explicit pre-production migration/operational gate.

- [ ] **Step 4: Implement repository adapters with transactions and idempotency keys**

Implement the deep `WorkflowStore` so each correctness-sensitive state change, event, artifact, and next outbox command commits atomically. Use optimistic run versions, invocation owner/lease expiry/heartbeat/takeover, monotonic event sequences, unique command/invocation IDs, immutable evidence hashes, and approval constraints. Claim outbox rows with `FOR UPDATE SKIP LOCKED`, publish to BullMQ with the command ID as `jobId`, and mark publication idempotently. The worker composition root owns a leaderless multi-replica-safe dispatcher loop with bounded batches, polling/backoff, metrics, readiness, and graceful shutdown. A PostgreSQL reconciler republishes nonterminal steps that lack both a committed/live invocation and a live command. Route exhausted delivery to an inspectable dead-letter queue.

Record `attempt_started` before every provider call and provider request/response IDs and usage afterward. External inference is explicitly at least once under crash ambiguity; an indeterminate retry is labeled `possible_duplicate` and consumes the run call/token budget.

- [ ] **Step 5: Verify migrations and repositories**

Run: `pnpm db:migrate && pnpm test:integration -- repositories.test.ts outbox-queue.test.ts`  
Expected: PASS for crash between commit/publish, Redis loss after accepted publication, worker death during a leased LLM step, expired-lease takeover, duplicate delivery, multi-dispatcher contention, dead-letter inspection, and idempotent migrations.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml drizzle.config.ts drizzle packages/infrastructure apps/worker tests/integration
git commit -m "feat: add durable PostgreSQL persistence"
```

### Task 4: Fetch, Generate, Classify, and Ingest Canonical Records

**Files:**
- Create: `scripts/fetch-fixtures.ts`, `scripts/generate-slack-fixtures.ts`, `scripts/ingest.ts`, `packages/core/src/application/evidence/{fixture-schemas,chunk}.ts`, `fixtures/cato/**`, `fixtures/cato/slack/account_team_updates.tsv`, `fixtures/cato/slack/generation.json`, `tests/unit/fixture-schemas.test.ts`, `tests/unit/chunk.test.ts`

**Interfaces:**
- Produces: `parseFixtureSet(root): FixtureSet`; `classifyEvidenceSensitivity(record, opportunity, policy): Classification`; `chunkDocument(document): EvidenceChunk[]`; `generateSlackFixtures(input, gateway): Promise<SlackUpdate[]>`.

- [ ] **Step 1: Write failing parser and Slack invariant tests**

```ts
it('requires two synthetic Slack updates per opportunity', () => {
  const parsed = slackUpdatesSchema.parse(candidateRows);
  const counts = Map.groupBy(parsed, row => row.opportunityId);
  expect([...counts.values()].every(rows => rows.length >= 2)).toBe(true);
  expect(parsed.every(row => row.syntheticNotice === true)).toBe(true);
});

it('rejects Slack PII and duplicated source text', () => {
  expect(() => validateSlackFixture(piiCandidate, providedSourceCorpus)).toThrow('slack_pii');
  expect(() => validateSlackFixture(verbatimDuplicate, providedSourceCorpus)).toThrow('slack_not_novel');
});

it('loads every mandatory provided source group', () => {
  expect(parseFixtureSet(root).inventory).toEqual([
    'accounts', 'opportunities', 'contacts', 'gong_summaries', 'gong_transcripts',
    'pricing_notes', 'access_permissions', 'deal_desk_policy', 'slack_updates',
  ]);
});
```

- [ ] **Step 2: Fetch the pinned source fixtures**

Run: `pnpm fixtures:fetch`  
Expected: the script downloads only commit `076c659c3c7afd416f8d26729774b67042a55761`, verifies its hash, copies the documented synthetic files into `fixtures/cato`, and records source attribution.

- [ ] **Step 3: Implement strict TSV and Markdown parsing**

Parse tabs, list-valued cells, ISO dates, booleans, identifiers, transcript content, policy Markdown, and sensitivity fields with Zod. Derive effective sensitivity from source type, opportunity restrictions, pricing content, and policy version before indexing; unknown pricing classification fails closed. Persist classification reason and policy hash. Reject duplicate IDs, unknown references, invalid chronology, or missing files.

- [ ] **Step 4: Implement deterministic chunking**

Chunk by semantic record boundaries: one Salesforce row, one Gong summary, transcript speaker windows with overlap, one Slack update, one pricing note, and policy headings. Derive stable IDs from `sourceType:externalId:chunkIndex` and attach account, opportunity, access level, event date, reliability class, and source locator.

- [ ] **Step 5: Generate Slack fixtures once through the gateway**

Use structured output to propose at least two updates per opportunity. Validate that every opportunity has a reinforcing fact, missing context, and ambiguity/conflict; validate chronology and synthetic notices. Reject real person/customer names, emails, phone numbers, sensitive identifiers, and verbatim/near-verbatim duplication of provided evidence; compare normalized n-grams and deterministic similarity against the eight provided source groups, then require human review of novelty classifications. Persist the reviewed TSV plus provider, model, prompt hash, timestamp, validation result, usage, input/output hashes, and a row-level `reinforces | adds_context | ambiguity_conflict` category keyed by `update_id` in `generation.json`. Runtime ingestion never regenerates these rows. A mock-generated fixture is valid only for deterministic tests/local development; Task 16 must replace it with a reviewed live-Ollama fixture before creating submission samples.

- [ ] **Step 6: Verify record-only ingestion idempotency**

Run: `pnpm vitest run tests/unit/fixture-schemas.test.ts tests/unit/chunk.test.ts && pnpm ingest:records && pnpm ingest:records`  
Expected: PASS; all eight provided source groups plus Slack appear in the inventory, the second ingest creates zero duplicates, no embedding call occurs, PII/novelty/category checks pass, Slack retains `source_type=slack`, and policy-derived sensitive pricing is stored as restricted.

- [ ] **Step 7: Commit**

```bash
git add scripts fixtures packages/core/src/application/evidence tests/unit
git commit -m "feat: add canonical and Slack fixture ingestion"
```

### Task 5: Implement Signed Demo Sessions and Default-Deny Authorization

**Files:**
- Create: `packages/contracts/src/auth.ts`, `packages/core/src/domain/permissions/authorize.ts`, `apps/api/src/modules/auth/{auth.controller,session,guard}.ts`, `apps/web/src/routes/{login,unauthorized,forbidden}.tsx`, `tests/unit/authorize.test.ts`, `tests/e2e/login.spec.ts`

**Interfaces:**
- Produces: `AuthController.getSession/selectPersona/logout`; `authorizeOpportunity(session, opportunity): AccessScope`; shared validated request/response contracts.

- [ ] **Step 1: Write the no-leak authorization tests**

```ts
it('denies USR-5007 access to restricted OPP-1003 without metadata', () => {
  const result = authorizeOpportunity(harperSession, restrictedOpportunity);
  expect(result).toEqual({ allowed: false, reason: 'forbidden' });
  expect(JSON.stringify(result)).not.toContain('ACC-2003');
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `pnpm vitest run tests/unit/authorize.test.ts`  
Expected: FAIL because authorization is undefined.

- [ ] **Step 3: Implement signed HTTP-only persona sessions**

Sign `{ userId, issuedAt, version }` with HMAC-SHA256 and constant-time verification. Cookies are `httpOnly`, `sameSite=lax`, `secure` in production, and expire after eight hours. Only canonical fixture personas and the checked-in, clearly synthetic Legal Reviewer and Restricted Sales Leader personas needed to exercise otherwise-unrepresented OPP-1003 policy authorities can be selected; their minimum-scope grants are controls, never evidence, and runtime arbitrary role creation is forbidden.

Bind production to one browser origin: the public web container reverse-proxies `/api` and SSE to the private API, and Vite uses the same proxy contract in development. Use a host-only `__Host-slacato_session` cookie (`Secure`, `HttpOnly`, `Path=/`, no `Domain`) in production. `GET /api/auth/csrf` bootstraps a session-bound token; the SPA returns it as `X-CSRF-Token` on login, persona changes, approvals, generation, and logout. Rotate it after authentication/persona/logout. Reject missing or hostile `Origin`/`Sec-Fetch-Site`; allow documented non-browser health traffic only on read-only endpoints. All authenticated fetches use `credentials: 'include'`. Keep an exact non-wildcard development CORS allowlist only where the proxy cannot be used, with `Vary: Origin`.

- [ ] **Step 4: Implement `AccessScope` from canonical grants**

Return an opaque denial or an allowed scope containing only permitted account IDs, source types, sensitive-pricing access, category-specific approval authorities, and restricted-account access. Keep `canRequestApproval` separate from `approvalAuthorities`; account owners cannot approve as Deal Desk, Sales Leader, or legal merely because they may request approval. Do not put denied opportunity details in errors, logs, or URLs.

- [ ] **Step 5: Build and test the persona login**

Render an API-loaded persona list with accessible shadcn cards and role descriptions. Selecting a persona sets the session and navigates only after the typed mutation succeeds. Verify keyboard use, CSRF bootstrap/rotation, allowed and hostile origins, preflight, missing/invalid CSRF, logout, cookie flags, and the denial page with integration tests and Playwright.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/auth.ts packages/core/src/domain/permissions apps/api/src/modules/auth apps/web/src/routes tests
git commit -m "feat: add permission-backed demo sessions"
```

### Task 6: Build Authorized Hybrid Retrieval with Exact pgvector, FTS, and RRF

**Files:**
- Create: `packages/core/src/application/evidence/{contracts,rrf,retriever,citations}.ts`, `packages/infrastructure/src/retrieval/postgres-retriever.ts`, `tests/unit/rrf.test.ts`, `tests/integration/retrieval.test.ts`, `evals/golden-retrieval.json`

**Interfaces:**
- Produces: `EvidenceRetriever.search(request: RetrievalRequest): Promise<RetrievedEvidence[]>`; `reciprocalRankFusion(lists, k): RankedId[]`; `CitationResolver.resolve(scope, citationId): Promise<AuthorizedCitation>`.

- [ ] **Step 1: Write RRF and authorization-first retrieval tests**

```ts
it('never returns a restricted chunk even when it is the closest vector', async () => {
  const results = await retriever.search({
    query: 'non-standard termination clause',
    opportunityId: opp1003,
    scope: harperScope,
    limit: 10,
  });
  expect(results).toEqual([]);
});
```

- [ ] **Step 2: Confirm tests fail before implementation**

Run: `pnpm vitest run tests/unit/rrf.test.ts && pnpm test:integration -- retrieval.test.ts`  
Expected: FAIL with missing retriever and fusion modules.

- [ ] **Step 3: Implement embedding ingestion and health validation**

Use `embedMany` with the adapter's AI SDK 7 embedding factory verified in Task 7. Verify the pinned dimension against the database column before `pnpm index:embeddings`; batch documents, persist model/dimension/normalization/content hashes, refuse mixed versions, and skip unchanged chunks.

- [ ] **Step 4: Implement permission-scoped parallel retrieval**

Build an `EvidencePlan`: exact authorized opportunity/account/contact lookups, fixed section/source queries, per-source top-k, total context budget, mandatory policy inclusion, deduplication, and missing-source diagnostics. Issue lexical and exact-cosine queries concurrently over the authorized subset. Both SQL queries include account, opportunity, source-type, effective-access, and sensitive-pricing predicates before ranking. Fuse stable IDs with RRF using `score = Σ 1/(60 + rank)` and apply documented bounded reliability/recency adjustments.

Immediately persist an immutable `RunEvidenceManifest` containing authorized chunk version IDs/hashes, locators, classification, ranks/scores, query hash, embedding/index version, policy hash, and originating scope hash. All specialists, repairs, validators, approvals, and exports use this manifest and never silently substitute re-ingested chunks. A deliberate refresh creates a new run/manifest version.

- [ ] **Step 5: Implement citation resolution defense-in-depth**

Resolve only stable citation IDs through both the current `AccessScope` and run evidence manifest. A denied, stale, or out-of-manifest citation returns the same opaque forbidden error as a denied opportunity and never reveals source type or existence.

Each authorized result also exposes a deterministic display label `source=<repository-relative path>, <stable key>=<stable ID>`; for example, `source=synthetic_data/gong/gong_call_summaries.tsv, call_id=CALL-008`. Internal chunk IDs remain secondary evidence-detail metadata and never replace the assignment-visible source path/stable ID.

- [ ] **Step 6: Verify golden retrieval and query plans**

Run: `pnpm test:integration -- retrieval.test.ts && pnpm tsx scripts/evaluate.ts retrieval`  
Expected: permission leakage is 0; baseline precision@k and recall@k are written to a deterministic JSON report; exact vector results retain full recall under selective permission filters.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/application/evidence packages/infrastructure/src/retrieval tests evals scripts/evaluate.ts
git commit -m "feat: add authorized hybrid evidence retrieval"
```

### Task 7: Freeze Compatibility and Implement the Capability-Aware Model Gateway and Context Policy

**Files:**
- Create: `docs/compatibility.md`, `packages/core/src/application/model/{contracts,registry,retry}.ts`, `packages/core/src/application/context/{contracts,context-window-policy}.ts`, `packages/infrastructure/src/model/{ollama,capabilities}.ts`, `tests/contract/model-gateway.test.ts`, `tests/contract/ollama-live.test.ts`, `tests/unit/{retry,context-window-policy}.test.ts`

**Interfaces:**
- Produces: `BudgetedModelGateway.generateObject<T>(request: GenerateObjectRequest<T>): Promise<GenerationResult<T>>`; `EmbeddingGateway.embed(values): Promise<number[][]>`; deterministic `ContextWindowPolicy.prepare(input): PreparedContext`; non-recursive `ContextCompactor.compact(input): Promise<ContextCheckpoint>`; `ModelRegistry` aliases `brief`, `specialist`, `compaction`, and `embedding`.

- [ ] **Step 1: Write a contract test for corrective retries**

```ts
it('returns Zod issues to the model before succeeding', async () => {
  const result = await gateway.generateObject({ schema, messages, operation: 'contract-test' });
  expect(result.value).toEqual(validObject);
  expect(fakeModel.calls[1].messages.at(-1)?.content).toContain('stakeholders.0.role');
  expect(result.attempts).toHaveLength(2);
});
```

- [ ] **Step 2: Implement generic contracts without domain imports**

`BudgetedModelGateway` is the sole public model seam. Provider adapters are private infrastructure; agents, live probes, Slack generation, retries, and scripts cannot call them directly. Enforce the complete package direction (`web/api/worker → core interfaces`, `infrastructure → core interfaces`, never `core → infrastructure/Nest/BullMQ/React`) with `eslint-plugin-boundaries`.

- [ ] **Step 3: Implement Ollama Cloud registry**

Create the deterministic mock provider as the test/local-development default and `createOllama({ baseURL: env.OLLAMA_BASE_URL, headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}` } })` as the strictly configured production-AI and reviewer/demo/submission mode. Compile Ollama against the pinned AI SDK 7/provider tuple and its actual embedding factory. Register aliases centrally; mock aliases are explicit `mock-*` IDs and must not be confused with live capability metadata. A live probe records exact Ollama model IDs, embedding dimension/normalization, and native schema support in `docs/compatibility.md`; it is required before live Slack generation, production AI activation, reviewer runs, interview demos, or submission artifacts, not before Task 3's dimension-flexible migration.

- [ ] **Step 4: Implement structured generation and bounded repair**

Set AI SDK `maxRetries: 0`. When the probe proves native schema support, use `generateText` with `Output.object({ schema })`; otherwise use ordinary `generateText`, a trusted serialized JSON Schema instruction, strict extraction of exactly one top-level JSON value, and Zod validation. Reject multiple candidates, trailing non-whitespace, duplicate keys, excessive depth/nodes, and oversized output. Return `native_schema` or `prompted_json` in every result so Task 9 persists it with the attempt. One controller bounds total calls, transport retries, schema repairs, deadline, and run budget and re-applies context budgeting after every repair. Prior invalid output is bounded and encoded as inert untrusted data with normalized Zod issue paths/codes, never appended as instructions. Capability probing has a separate budget. Never retry authorization, policy, content filtering, deterministic citation failures, or non-retryable 4xx responses.

- [ ] **Step 5: Verify contract and live opt-in health tests**

Implement a deterministic, model-free `ContextWindowPolicy` with provider/model context metadata, reserved output capacity, per-section budgets, and stable retention of instructions, current task input, evidence/citation IDs, and recent messages. Keep the separately built `ContextCompactor` dormant behind a future-only composition flag; it uses a non-recursive gateway mode and remains unit-tested, but no initial-release workflow enables it. Bound Part 1 agents through pruning and retrieval limits and assert zero compactor invocations in release flows.

Run: `pnpm vitest run tests/contract/model-gateway.test.ts tests/unit/retry.test.ts tests/unit/context-window-policy.test.ts`  
Expected: PASS with exact call counts; oversized inputs are bounded, runaway loops stop, and initial-release paths invoke the dormant compactor zero times. Its existing isolated contract tests remain green but are not a live submission gate. Run `LIVE_AI=1 pnpm vitest run tests/contract/ollama-live.test.ts`; it validates chat, embedding dimension, warnings, and all four real agent schemas through the selected output mode.

- [ ] **Step 6: Commit**

```bash
git add docs/compatibility.md packages/core/src/application/model packages/core/src/application/context packages/infrastructure/src/model tests/contract tests/unit eslint.config.mjs
git commit -m "feat: add provider-neutral Ollama model gateway"
```

### Task 8: Implement Four Specialized Agents with Validated Artifacts

**Files:**
- Create: `packages/core/src/application/agents/{conversation,stakeholder,commercial,strategy}.ts`, `packages/core/src/application/briefs/prompts.ts`, `tests/contract/agents.test.ts`
- Modify: `packages/core/src/application/agents/contracts.ts`

**Interfaces:**
- Produces: `ConversationAgent.run(context): Promise<ConversationArtifact>`; `StakeholderAgent.run(context): Promise<StakeholderArtifact>`; `CommercialAgent.run(context): Promise<CommercialArtifact>`; `StrategyAgent.run(context, artifacts): Promise<DealBrief>`.

- [ ] **Step 1: Write contract tests using a recording gateway**

```ts
it('commercial agent receives only authorized commercial evidence', async () => {
  await commercialAgent.run(authorizedContext);
  const request = recordingGateway.requests[0];
  expect(request.messages.join('\n')).not.toContain('RESTRICTED_PRICING_SENTINEL');
  expect(request.operation).toBe('commercial-policy-analysis');
});
```

- [ ] **Step 2: Define narrow agent schemas and prompts**

Each agent receives a bounded immutable evidence manifest and opportunity context through a shared prompt envelope: trusted system policy, trusted task instructions, and untrusted evidence records encoded as inert data with stable IDs and fixed delimiters. Evidence instructions, role claims, tool requests, schemas, and citation forgeries are explicitly non-executable. Agents have `tools: none` and no repository access. Artifacts reference evidence IDs instead of copying excerpts. Strategy receives bounded artifacts plus only their cited excerpts. Deterministic pruning priority is mandatory policy, canonical CRM facts, cited contradictions, then remaining ranked chunks. Every contract returns a discriminated `success | degraded | failed` outcome with safe error code, validation issues, and trace linkage.

- [ ] **Step 3: Implement agents over `ModelGateway`**

Use composition, not inheritance. Each module owns its prompt and Zod schema and delegates generation mechanics to the generic gateway. Specialist agents cannot import or call one another.

- [ ] **Step 4: Validate citation shape before synthesis**

Reject duplicate claim IDs, unknown/stale citations, wrong opportunity/account bindings, and confidence outside `[0,1]`. Validate critical entities, numbers, currencies, percentages, dates, quotes, competitors, stakeholders, and legal terms against authorized manifest evidence; classify support as `supported`, `contradicted`, or `insufficient`. Critical/material claims require 100% support. Contradicted claims fail; insufficient claims are removed from factual/recommendation assertions and become Missing Information or explicitly labeled hypotheses requiring review. Test worst-case three-specialist and corrective-retry fan-in against the smallest configured model window.

Run deterministic unsafe-language validation over recommendation and customer-language fields before an artifact is accepted. Block threats, deception, discriminatory/harassing language, fabricated commitments, unapproved pricing/legal promises, and instructions to bypass policy. `confidence < 0.70`, conflict, or missing material evidence creates a human-review trigger and cannot be rendered as approved customer language.

- [ ] **Step 5: Verify all agent contracts**

Run: `pnpm vitest run tests/contract/agents.test.ts && pnpm typecheck`  
Expected: four agents pass; malformed structured output, timeout/provider failure, missing required input, denied evidence, and unsafe language each produce the declared safe outcome. Conversation failure degrades by omitting conversation assertions; stakeholder failure degrades to deterministic CRM contacts with inferred roles unavailable; commercial/policy failure and strategy failure are fatal. The dependency-boundary lint rule rejects a deliberate cross-agent import, then passes after removing it.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/application/agents packages/core/src/application/briefs/prompts.ts tests/contract
git commit -m "feat: add specialized deal intelligence agents"
```

### Task 9: Implement the BullMQ Deal Brief Workflow and Immutable Approval Policy

**Files:**
- Create: `packages/core/src/application/briefs/workflow.ts`, `packages/core/src/domain/briefs/policy.ts`, `packages/core/src/application/approvals/decide-approval.ts`, `apps/api/src/modules/{runs,approvals}/*`, `apps/worker/src/processors/deal-brief.processor.ts`, `tests/unit/policy.test.ts`, `tests/integration/workflow.test.ts`

**Interfaces:**
- Produces: `StartDealBrief.execute(command): Promise<RunId>`; `ProcessDealBriefStep.execute(command): Promise<void>`; `decideApprovalRequirement(input): ApprovalRequirement`; `DecideApproval.execute(command): Promise<ApprovalResult>`.

- [ ] **Step 1: Write durable workflow tests**

```ts
it('stops at approval and resumes without repeating completed agents', async () => {
  const runId = await workflow.enqueue(restrictedCommand);
  await worker.drain();
  expect((await runs.get(runId))?.status).toBe('awaiting_approval');
  expect(await queue.getParkedJob(runId)).toBeNull();
  const beforeHash = (await approvals.getPending(runId)).subjectHash;
  await decideApproval.execute(approvedDecision);
  await worker.drain();
  expect((await runs.get(runId))?.status).toBe('completed');
  expect((await briefs.getCurrent(runId)).subjectHash).toBe(beforeHash);
  expect(recordingAgents.conversation.calls).toBe(1);
});
```

- [ ] **Step 2: Implement policy rules as deterministic code**

Parse the canonical policy into explicit tested rules for discounts, non-standard legal/commercial terms, restricted accounts, sensitive pricing, and approver roles. Represent approval as a set of required category/authority entries, not one boolean: `discount > 10%` or negative renewal uplift requires Deal Desk; `discount > 15%` requires the distinct quorum Deal Desk **and** Sales Leader; liability-cap changes and data-retention/restricted-research/customer-specific-security language require Legal Reviewer authority; low confidence (`< 0.70`), conflicting evidence, or missing material evidence requires scoped human review by the account owner or Sales Leader; customer-facing concession language requires account-owner confirmation after all underlying entries pass. `canRequestApproval` only permits submission and never satisfies an authority. One actor may satisfy only authorities explicitly granted to that persona, each required entry has its own decision, all entries must approve, and any rejection rejects the immutable subject. Add checked-in candidate-created synthetic Legal Reviewer and Restricted Sales Leader grants because the source fixture defines those OPP-1003 approval needs but has no appropriately scoped personas; keep them out of evidence retrieval, prevent them from weakening canonical denials, and document them as demo-only identities. Agents may summarize policy but cannot decide authorization or mandatory approval.

- [ ] **Step 3: Implement checkpointed orchestration**

Create the run and outbox command in one transaction. The outbox dispatcher publishes an idempotent BullMQ job; its thin processor invokes `ProcessDealBriefStep`. Specialists use independently checkpointed `Promise.allSettled`, with bounded retry and the explicit Task 8 degraded/fatal matrix: conversation or stakeholder degradation may continue with warnings and removed/limited claims, while commercial/policy or strategy failure is fatal. Duplicate delivery or process loss reruns only uncommitted step invocations. Concurrent start/approval commands use idempotency keys, optimistic versions, and active-run rejoin rather than duplicate paid calls. When approval is required, persist `awaiting_approval` and finish the job; the decision endpoint atomically records each authority decision and enqueues continuation/finalization only after quorum is satisfied.

Model retries belong only to the Task 7 retry controller. BullMQ attempts recover delivery/process failure and never create an unbounded inner model retry loop. Configure lock renewal for long calls, one initial worker replica, explicit worker/model concurrency and rate limits, graceful draining, and a per-run call/token budget shared by all specialists. A crash-ambiguous provider call may repeat and is labeled/counts as `possible_duplicate`; exactly-once paid inference is not claimed.

- [ ] **Step 4: Persist every generation and audit event**

Create the run before any model call. Approval binds to immutable `draftVersion`, `subjectHash`, exact section/recommendation IDs, citations, policy triggers, required authority, and quorum version. Actions are `approve_unchanged`, `edit_and_approve`, and `reject`; edit-and-approve and reject require rationale. Use compare-and-swap for stale tabs, store original/edited/diff/actor/authority/category/time, and revalidate the exact approved payload for schema, authorization, claim support, citations, confidence, policy, and unsafe language. Finalize that snapshot without another LLM call only after all required entries approve. A regeneration creates a new version and invalidates every prior entry.

- [ ] **Step 5: Verify restricted and unauthorized scenarios**

Run: `pnpm test:integration -- workflow.test.ts`  
Expected: authorized OPP-1001/1002 complete; authorized OPP-1003 has no parked queue job while waiting and cannot finalize after only one approver. The 18% discount requires separate Deal Desk and Sales Leader entries, legal language requires the synthetic Legal Reviewer, and customer-facing concession language requires account-owner confirmation; category mismatches and a requester attempting to use ungranted authority fail closed. Satisfying the complete quorum creates exactly one deterministic finalization for approve/edit-and-approve and none for reject; the approved snapshot hash is unchanged and agent call counts do not increase. Low-confidence/conflicting/missing-evidence cases stay review-gated; unsafe language cannot be approved. Stale/double/conflicting decisions are safe; conversation/stakeholder partial failure follows degraded mode, commercial/policy or strategy failure is terminal, and USR-5007 creates no generation attempt or artifact but does create an opaque denial audit event containing no restricted metadata.

- [ ] **Step 6: Commit**

```bash
git add packages/core apps/api/src/modules apps/worker/src/processors tests
git commit -m "feat: add durable brief and approval workflow"
```

### Task 10: Add Append-Only Traces and Generic SSE Progress with Replay

**Files:**
- Create: `packages/contracts/src/events.ts`, `packages/infrastructure/src/events/postgres-event-store.ts`, `apps/api/src/modules/runs/run-events.controller.ts`, `tests/unit/event-bus.test.ts`, `tests/integration/sse-controller.test.ts`

**Interfaces:**
- Produces: `RunEventBus.publish(envelope): Promise<void>`; `RunEventBus.subscribe(streamId, afterId): AsyncIterable<RunEventEnvelope>`.

- [ ] **Step 1: Write replay and isolation tests**

```ts
it('replays only authorized events after Last-Event-ID', async () => {
  const events = await collect(bus.subscribe(runId, 'evt-2'), 2);
  expect(events.map(event => event.id)).toEqual(['evt-3', 'evt-4']);
  expect(events.every(event => event.streamId === runId)).toBe(true);
});
```

- [ ] **Step 2: Implement generic event envelopes**

Keep append-only traces separate from the user-facing SSE projection. Trace spans record trace/span/parent IDs, run/step/attempt, kind, timestamps, status, safe hashes, retrieval result IDs/scores, policy/guardrail decisions, approval subject/category/authority decision, recommendation IDs, model parameters, and usage. Record pre-retrieval opportunity/account/requester/permission reads as redacted `authorization_lookup` spans; they are excluded from evidence/result counts and model context. Record authorized search separately as `evidence_retrieval`. A denied lookup trace contains only safe decision/correlation data. SSE envelopes contain DB-backed monotonic sequence, stream ID, type, version, timestamp, and safe Zod-validated payload; transport has no deal semantics. After committing an event the worker emits PostgreSQL `NOTIFY`; every API replica owns one dedicated `LISTEN` connection as a wake-up only, then reads authoritative ordered events from PostgreSQL.

Implement `assertTraceComplete(runId)` for deterministic tests and artifact verification. A permitted terminal run must link authorization, evidence retrieval, each specialist and strategy attempt, model call, validation/repair, guardrail, policy/approval requirement, recommendation, all approval decisions, finalization, and usage. A denied run requires only its safe authorization chain and must contain no evidence, agent, citation, recommendation, or restricted locator spans. A degraded/failed run must link the triggering agent attempt and typed partial/fatal decision.

- [ ] **Step 3: Implement authorized SSE route**

The initial state query returns a snapshot watermark. The first/reloaded native `EventSource` connects to `GET /api/runs/:runId/events?after=<watermark>` because browser code cannot set `Last-Event-ID`; automatic reconnect also honors the browser-supplied header. The Nest controller validates and authorizes either cursor, replays strictly after it, sends comment heartbeats below proxy idle limits, deduplicates, closes on terminal/abort, and sets `text/event-stream`, `no-cache`, `no-transform`, `keep-alive`, and anti-buffering headers. Use a raw response adapter if `@Sse()` cannot provide exact framing. An expired cursor emits a typed resync instruction: refetch snapshot/watermark and reconnect. Inaccessible runs remain opaque.

- [ ] **Step 4: Verify reconnect behavior**

Run: `pnpm vitest run tests/unit/event-bus.test.ts && pnpm test:integration -- sse-controller.test.ts`  
Expected: snapshot/subscribe race, reload cursor, native reconnect, duplicates, expired-cursor resync, terminal close, clean abort, heartbeat framing, worker-to-API cross-process wakeup, and two API replicas all pass without gaps or cross-run events. Trace completeness passes for completed, awaiting-approval, degraded, failed, and denied runs; authorization lookups are never mislabeled or counted as evidence.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/infrastructure/src/events apps/api/src/modules/runs tests
git commit -m "feat: stream resumable run progress over SSE"
```

### Task 11: Build the Responsive Product Shell, Persona Settings, and Demo Diagnostics

**Files:**
- Create: `apps/web/src/components/{app-shell,mobile-nav,persona-menu,status-badge,permission-matrix}.tsx`, `apps/web/src/routes/{root,settings,diagnostics}.tsx`, route error/pending components, `apps/web/src/api/{client,session}.ts`, `tests/e2e/responsive-shell.spec.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: serializable `DemoSession`, `PermissionGrantView`, `ProviderHealthView`.
- Produces: responsive shell and working persona switcher.

- [ ] **Step 1: Write mobile/desktop accessibility tests**

```ts
test('shows all primary destinations in accessible mobile navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  for (const label of ['Deals', 'Runs', 'Approvals', 'Settings']) {
    await expect(page.getByRole('link', { name: label })).toBeVisible();
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
```

- [ ] **Step 2: Implement the API-backed product shell**

Load the signed session and navigation view through the typed API client and TanStack Query, with route loaders/error boundaries and no secret-bearing state. At `lg` (1024px) use a 72px collapsed/240px expanded forest rail; below it use a four-item bottom bar with safe-area padding. Main content is max 1280px. Verify 320, 390, 768, 1024, and 1440px, landscape phone, short desktop, and 200% zoom. All touch targets are at least 44px; include skip link, landmarks, `aria-current`, visible focus, forced-colors, and reduced-motion behavior.

Define the concrete React Router tree, protected auth bootstrap, intended-destination restoration, catch-all/not-found route, and route-level pending/error boundaries. Loaders call `queryClient.ensureQueryData` using shared query options rather than duplicating fetch ownership. Authorization-sensitive query keys include the session/persona version. On persona change, close SSE first, increment a connection-generation token, cancel/remove scoped queries synchronously, then navigate. Use `BroadcastChannel` to propagate persona/logout changes to other tabs so they close streams and clear caches before rendering again.

- [ ] **Step 3: Implement the settings views**

Settings contains only persona/session controls. A secondary read-only Demo Diagnostics page shows a permission matrix that separates request permission from Account Owner, Sales Leader, Deal Desk, and Legal Reviewer decision authority, plus output mode, pinned generation/embedding model, index health, and runtime readiness. Persona switching aborts SSE, closes Sheets/dialogs, clears client caches, reauthorizes the route, and safely redirects if access changed. Product copy identifies SlaCato as a negotiation-preparation assistant: recommendations are internal, evidence-backed suggestions; sellers own judgment; no control autonomously sends customer-facing content.

- [ ] **Step 4: Verify visual tokens and responsive behavior**

Run: `pnpm test:e2e -- responsive-shell.spec.ts settings.spec.ts`  
Expected: desktop rail, mobile nav, keyboard-only journey, focus order, 44px targets, no overflow at 320px or 200% zoom, verified token contrast, zero serious/critical axe violations, and reviewed lower-severity findings.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src tests/e2e
git commit -m "feat: add responsive Cato-led product shell"
```

### Task 12: Build Deal, Brief, Evidence, and Audit Surfaces

**Files:**
- Create: `packages/contracts/src/deals.ts`, `apps/api/src/modules/deals/*`, `apps/web/src/features/{deals,briefs}/*`, `apps/web/src/routes/{deals,deal}.tsx`, `tests/e2e/deals.spec.ts`, `tests/e2e/no-leak-ui.spec.ts`

**Interfaces:**
- Produces: `listAuthorizedDeals(session): Promise<DealListItem[]>`; `getAuthorizedDealWorkspace(session, opportunityId): Promise<DealWorkspaceView>`.

- [ ] **Step 1: Write UI behavior and no-leak tests**

```ts
test('unauthorized persona cannot discover OPP-1003', async ({ page }) => {
  await loginAs(page, 'USR-5007');
  await page.goto('/deals');
  await expect(page.getByText('OPP-1003')).toHaveCount(0);
  await page.goto('/deals/OPP-1003');
  await expect(page.getByText(/restricted|pricing|account name/i)).toHaveCount(0);
});
```

- [ ] **Step 2: Implement authorized API queries**

NestJS controllers call authorization-aware application queries and list only deals in the current scope. Fetch independent workspace sections concurrently. Map dates and database records to Zod-validated ISO-string response models before the HTTP boundary; TanStack Query owns client caching and invalidation.

- [ ] **Step 3: Implement brief-first deal workspace**

Compose shadcn header, status badges, metric cards, nine brief sections, stakeholder table, actions, warnings, and citations. Every visible citation uses `source=<repository-relative path>, <stable key>=<stable ID>`; the citation control's accessible name includes that label and evidence detail shows the secondary chunk ID. Add an explicit “Account-team update impact” indicator when cited Slack evidence changes a finding, warning, missing-information item, or recommendation. Avoid nested cards and show designed empty/loading/error states.

- [ ] **Step 4: Implement responsive evidence detail**

Clicking a real, labeled citation control opens a 360–440px desktop non-modal complementary region only when the main column remains at least 640px; it receives deterministic focus entry/return without trapping focus. Below 1024px it becomes a modal full-height Sheet with title/description, close/Escape, focus trap/restoration, inert background, and scroll lock. Both modes provide independent scrolling, selected state, deep-link/back behavior, and replacement rather than stacked panels. Desktop tables use captions/headers; mobile renders complete stacked key-value records rather than squeezed or hidden columns.

- [ ] **Step 5: Verify desktop and mobile stories**

Run: `pnpm test:e2e -- deals.spec.ts no-leak-ui.spec.ts`  
Expected: authorized briefs render all sections and path/stable-ID citations; a Slack-cited scenario visibly identifies the affected brief content. Unauthorized navigation leaks no names, counts, source types, snippets, or citation locators.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/deals.ts apps/api/src/modules/deals apps/web/src/features apps/web/src/routes tests/e2e
git commit -m "feat: add authorized deal and evidence workspace"
```

### Task 13: Build Runs Index, Live Run, and Approval Inbox Experiences

**Files:**
- Create: `packages/contracts/src/{runs,approvals}.ts`, `apps/api/src/modules/{runs,approvals}/*`, `apps/web/src/features/{runs,approvals}/*`, `apps/web/src/routes/{runs,run,approvals}.tsx`, route error/pending components, `tests/e2e/run-resume.spec.ts`, `tests/e2e/approval.spec.ts`

**Interfaces:**
- Consumes: SSE `RunEventEnvelope`; REST commands `startBrief`, `decideApproval`.
- Produces: reconnectable progress UI and approval edit/approve/reject UI.

- [ ] **Step 1: Write refresh/rejoin and approval tests**

```ts
test('refresh rejoins the same awaiting-approval run', async ({ page }) => {
  const runId = await startRestrictedRun(page);
  await expect(page.getByText('Awaiting approval')).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
  await expect(page.getByText('Awaiting approval')).toBeVisible();
});
```

- [ ] **Step 2: Implement create-then-redirect generation UX**

The deal workspace owns one primary Generate Brief action. The NestJS command endpoint validates access, uses a client operation key, transactionally creates the run plus outbox record once, and returns the existing active run when present. React navigates to `/runs/[runId]` only after the typed mutation succeeds. Pending state disables duplicate submission; safe failure preserves context and offers retry. The route reads persisted state plus watermark and subscribes only while non-terminal. SSE handlers validate every envelope, ignore sequences at or below the current watermark, patch only the matching run cache, use the current connection-generation token, and invalidate canonical run/deal/index/approval queries on terminal or approval transitions.

- [ ] **Step 3: Implement safe live progress**

Render phase, specialist status, retrieval counts, validation retry summaries, and completed validated sections. A single atomic `aria-live=polite` message announces major phase changes only; the detailed timeline is outside the live region. Add last-updated, offline/reconnecting, stalled, retryable failure, terminal failure, rejected, and completed states. Never display raw prompts, hidden reasoning, secrets, or restricted excerpts.

- [ ] **Step 4: Implement approval inbox and decisions**

The `/runs` index lists only scoped runs with safe deal identity, initiator, updated time, status, and Rejoin/View action, including active, awaiting approval, completed, rejected, failed, and empty states. Approval inbox orders pending first, separates decided history, shows age/category/required authority/quorum progress/assigned approver, deep-links authorized evidence/run, and uses stacked mobile rows. Actions are Approve unchanged, Edit and approve, and Reject, with rationale/diff/CAS semantics from Task 9; editing alone never resumes, an actor cannot operate a category without its explicit grant, and partially satisfied quorum remains awaiting approval.

- [ ] **Step 5: Verify refresh, reconnect, and role switch behavior**

Run: `pnpm test:e2e -- run-resume.spec.ts approval.spec.ts`  
Expected: deal → generate → stable run → completion works; double-click creates one run; refresh/reconnect rejoin; Runs navigation is live; stale/double approval is safe; reject is terminal; persona switch tears down stale UI/streams; unauthorized deep links to deal/run/approval/evidence/export reveal nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src apps/api/src/modules apps/web/src/features apps/web/src/routes tests/e2e
git commit -m "feat: add resumable run and approval experiences"
```

### Task 14: Add Safe Logging, Audit, and JSON/Markdown Exports

**Files:**
- Create: `packages/infrastructure/src/logging/{logger,redaction}.ts`, `packages/core/src/application/briefs/exports.ts`, `apps/api/src/modules/exports/exports.controller.ts`, `tests/unit/redaction.test.ts`, `tests/integration/export-controller.test.ts`

**Interfaces:**
- Produces: `logger`; `redactLogPayload(value): SafeLogPayload`; `exportBrief(brief, format): string`.

- [ ] **Step 1: Write secret and evidence-redaction tests**

```ts
it('redacts keys, prompts, and source bodies', () => {
  expect(redactLogPayload({ apiKey: 'secret', prompt: 'private', runId: 'run_1' }))
    .toEqual({ apiKey: '[REDACTED]', prompt: '[REDACTED]', runId: 'run_1' });
});
```

- [ ] **Step 2: Implement structured logging**

Log stable event name, correlation/run/attempt ID, status, provider/model, duration, retry count, token usage, and safe error code. Pino redaction covers authorization headers, cookies, API keys, messages, prompts, completions, source content, and evidence excerpts.

- [ ] **Step 3: Implement authorized exports**

The route awaits params, authorizes run and citations, and returns canonical JSON or deterministic Markdown containing all nine sections and citation labels. Set safe filenames, content type, `Content-Disposition`, and `Cache-Control: private, no-store`.

- [ ] **Step 4: Verify redaction and exports**

Run: `pnpm vitest run tests/unit/redaction.test.ts && pnpm test:integration -- export-controller.test.ts`  
Expected: no sentinel secret/source body appears in logs; authorized exports parse and unauthorized exports reveal nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/logging packages/core/src/application/briefs/exports.ts apps/api/src/modules/exports tests
git commit -m "feat: add safe audit logging and exports"
```

### Task 15: Add Full-Pipeline Evaluation, Promptfoo, and Security Regression Gates

**Files:**
- Create: `evals/promptfooconfig.yaml`, `evals/golden-retrieval.json`, `evals/security-cases.json`, `scripts/evaluate.ts`, `tests/security/authorization.test.ts`, `tests/security/prompt-injection.test.ts`, `tests/integration/{source-utilization,trace-completeness,partial-failure}.test.ts`, `tests/e2e/assignment-scenarios.spec.ts`, `.github/workflows/ci.yml`, `.github/workflows/live-eval.yml`

**Interfaces:**
- Produces: `pnpm eval:deterministic`; `pnpm eval:live`; sanitized `artifacts/evals/source-coverage.json`; reports under ignored `artifacts/evals/`.

- [ ] **Step 1: Write deterministic metric tests**

```ts
it('fails the suite on any permission leakage', () => {
  const report = scoreCases([{ expectedForbidden: true, returnedEvidenceIds: ['ev_restricted'] }]);
  expect(report.permissionLeakageRate).toBe(1);
  expect(() => assertEvaluationThresholds(report)).toThrow('permission leakage');
});

it('fails when a terminal run omits a required trace stage', () => {
  expect(() => assertTraceComplete(traceWithoutCommercialAttempt)).toThrow('trace_incomplete');
});

it('keeps authorization lookup out of evidence accounting', () => {
  expect(scoreTrace(traceWithAuthLookup).retrievedEvidenceCount).toBe(0);
});

it('fails when any canonical source misses an expected utilization stage', () => {
  const report = buildSourceCoverage(traceFixtures.withoutGongTranscriptReceipt);
  expect(() => assertSourceCoverage(report)).toThrow('gong_transcripts:agent_receipt_missing');
});
```

- [ ] **Step 2: Implement focused TypeScript evaluators**

Compute precision@k, recall@k, citation resolution/authorization, claim support, required-section completeness, policy trigger/quorum correctness, injection/unsafe-language containment, source utilization, trace completeness, Slack novelty/authorization/impact, and permission leakage. Build `source-coverage.json` with exactly eight entries containing `sourceGroup`, inventory count/hash, authorized retrieval/control trace ID, expected and observed agent IDs, resulting section/claim/citation label, `expectedUtilizationRule`, and status; sanitize source bodies, prompts, denied locators, and restricted metadata. Hard gates are leakage `= 0`, citation resolution and required visible path/stable-ID labels `= 100%`, critical/material claim support `= 100%`, required sections `= 100%`, policy/approval correctness `= 100%`, required trace stages `= 100%`, all eight source-utilization entries and every required stage `= pass`, Slack PII violations `= 0`, context overflow `= 0`, initial-release compactor calls `= 0`, and retry/call-budget violations `= 0`. Inventory alone is never sufficient. Label retrieval thresholds before freezing them.

Use these executable required/allowed receipt rules, matching Task 8 routing:

- accounts, opportunities, contacts: require both Stakeholder and Commercial receipt because both specialists intentionally receive authorized Salesforce records; require respectively Deal Snapshot account, Deal Snapshot/Negotiation State, and Stakeholder Map claim/citation output;
- Gong summaries and transcripts: require Conversation and Stakeholder receipt; require a Buyer Goals, Negotiation State, Stakeholder Map, or Missing Information claim/citation appropriate to the record;
- pricing notes: require sensitivity-filtered Commercial receipt in a pricing-authorized scenario and a commercial claim/recommendation/warning citation;
- Deal Desk policy: require mandatory retrieval, deterministic policy evaluation, Commercial receipt, and approval/review-warning output with policy citation;
- access permissions: require only `authorization_lookup` and allowed scope or opaque denial, with zero agent receipt, evidence count, claim, or citation;
- Strategy may receive any of the authorized evidence groups above only when the exact manifest-bound evidence was cited by a validated specialist artifact; it receives no uncited union members.

Hard-fail a missing required receipt/output stage, Salesforce delivered to Conversation, Gong delivered to Commercial, pricing/policy delivered to Conversation or Stakeholder, any access-permission delivery to an agent, or uncited/out-of-manifest Strategy evidence. Do not fail the intended dual Salesforce/Gong specialist routing or cited Strategy union.

- [ ] **Step 3: Configure Promptfoo narrowly**

Use a custom TypeScript Promptfoo provider that calls the full authorized retrieval → agents → grounding → policy pipeline through a test-run harness with a fixed persona, isolated run namespace, deterministic fixture reset, bounded terminal polling, and explicit `completed | awaiting_approval | denied | failed` expectations. Score approval drafts before applying deterministic authorized decisions for every required quorum entry. Evaluate context relevance/recall, faithfulness, answer relevance, and required sections. Add checked-in RBAC/BOLA, evidence-reingestion resume, irrelevant-but-valid citation, partial numeric support, conflicting/stale evidence, cross-source injection propagation, multiple/trailing/deep prompted-JSON, RAG attribution, poisoned-context, unsafe customer language, low-confidence, category-mismatched approver, and incomplete-quorum fixtures. Disable sharing/telemetry and sanitize unauthorized reports of evidence IDs, scores, account metadata, prompts, source bodies, and locators. Do not use hosted poison generation or Python. Dormant compactor contract tests remain isolated infrastructure tests and do not enter the initial-release live evaluation.

Add deterministic integration/E2E scenarios for malformed opportunity IDs and request bodies, missing opportunity/source data, opaque OPP-1003 denial, conversation-only and stakeholder-only degraded runs, commercial/policy and strategy fatal runs, partial multi-agent failure, stale/double approval, incomplete and complete quorum, and Slack impact. The Slack test runs the same authorized case against manifests with and without Slack, requires at least one stable Slack citation in the enabled run, and asserts a specific changed finding/warning/action without requiring unstable prose equality.

- [ ] **Step 4: Configure CI separation**

PR CI runs install, lint, typecheck, unit, integration, build, Playwright critical paths including `assignment-scenarios.spec.ts`, and deterministic evals. `live-eval.yml` runs manually/scheduled with Ollama secrets, fails if the provider reports `mock`, and uploads sanitized Promptfoo/red-team reports. It never runs untrusted fork code with secrets.

- [ ] **Step 5: Verify all gates locally**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm test:e2e && pnpm eval:deterministic`  
Expected: all deterministic gates pass; permission leakage, Slack PII violations, unsafe-language escapes, and authorization-lookups-counted-as-evidence are exactly 0; citation/source/trace/section/policy/quorum completeness are 100%; every degraded/fatal agent path matches its declared behavior.

- [ ] **Step 6: Commit**

```bash
git add evals scripts/evaluate.ts tests/security .github
git commit -m "test: add RAG and security evaluation gates"
```

### Task 16: Generate and Verify Mandatory Live Submission Artifacts

**Files:**
- Create: `scripts/generate-live-artifacts.ts`, `scripts/verify-live-artifacts.ts`, `scripts/approve-slack-fixture.ts`, `tests/contract/live-artifacts.test.ts`, `artifacts/samples/README.md`, sanitized `artifacts/samples/**`
- Modify: `scripts/generate-slack-fixtures.ts`, `fixtures/cato/slack/{account_team_updates.tsv,generation.json}`, `package.json`

**Interfaces:**
- Produces: `pnpm fixtures:slack:live`; `pnpm fixtures:slack:approve`; `pnpm demo:generate-live`; `pnpm verify:live-artifacts`.

- [ ] **Step 1: Write failing live-provenance and source-coverage tests**

```ts
it.each(['mock', 'replay', 'fake'])('rejects %s Slack or sample provenance', marker => {
  expect(() => verifyLiveSubmission(fixtureWithProviderMarker(marker))).toThrow('live_provenance_required');
});

it('rejects samples built from a different Slack fixture version', () => {
  expect(() => verifyLiveSubmission(sampleWithSlackHash('stale-hash'))).toThrow('slack_fixture_hash_mismatch');
});

it('rejects canonical source coverage with a missing stage', () => {
  expect(() => verifyLiveSubmission(coverageWithout('pricing_notes', 'agentReceipt')))
    .toThrow('source_coverage_incomplete');
});
```

Run: `pnpm vitest run tests/contract/live-artifacts.test.ts`
Expected: FAIL because the live submission verifier and coverage gate do not exist.

- [ ] **Step 2: Regenerate, review, and reingest the submitted Slack fixture with live Ollama**

Run the credentialed probe, then generate into the canonical fixture path with fake/replay disabled:

```bash
LIVE_AI=1 AI_PROVIDER=ollama pnpm vitest run tests/contract/ollama-live.test.ts
LIVE_AI=1 AI_PROVIDER=ollama pnpm fixtures:slack:live -- --require-live --output fixtures/cato/slack
pnpm fixtures:slack:approve -- --reviewer candidate --input fixtures/cato/slack
LIVE_AI=1 AI_PROVIDER=ollama pnpm ingest:records
LIVE_AI=1 AI_PROVIDER=ollama pnpm index:embeddings
```

`fixtures:slack:live` overwrites any mock-development TSV/metadata only after atomic validation succeeds. `generation.json` must contain provider `ollama`, exact model and output mode, provider request IDs when available, nonzero calls/input/output/total tokens, prompt/schema/source-corpus/output hashes, generated time, no replay/fake marker, and row-level `reinforces | adds_context | ambiguity_conflict` category keyed by every `update_id`. The approval command reruns deterministic PII/novelty/chronology/category validation and records reviewer/time/status without changing rows. Ingestion and indexing persist the approved TSV content hash and live embedding profile; subsequent sample manifests must bind to that hash. Any failure leaves the previous fixture intact and blocks submission.

- [ ] **Step 3: Implement the live scenario runner**

Run OPP-1001 and OPP-1002 as their authorized owners; run OPP-1003 as its authorized owner through its complete Deal Desk + Sales Leader + Legal Reviewer + account-owner-confirmation quorum when those categories are triggered; run OPP-1003 as USR-5007 to prove denial; and run one authorized case with and without Slack to demonstrate a specific brief impact and stable Slack citation. Disable fake gateways and replay; require four distinct specialist invocations with nonzero usage. Abort immediately when capability/provider metadata reports `mock`, required Ollama credentials/models are absent, or the credentialed probe has not passed.

- [ ] **Step 4: Export sanitized, provenance-rich artifacts**

Save canonical brief JSON/Markdown, specialist artifacts, the reviewed live Slack TSV and `generation.json`, with/without-Slack impact comparison, immutable approval subject/all quorum decisions/diffs, complete trace export, capability/output mode, exact provider/model and inference parameters, timestamps, usage/cost, prompt/schema/evidence/Slack-fixture hashes, evaluation summary, and sanitized `source-coverage.json`. The coverage file has exactly the eight required canonical groups and proves each inventory → authorized retrieval/control → intended agent receipt → result chain or the access-permissions authorization-only rule. Citations use the visible path/stable-ID format. Exclude secrets, source bodies, prompts, unauthorized locators, and restricted metadata.

- [ ] **Step 5: Verify artifact authenticity and compliance**

Run: `pnpm demo:generate-live && pnpm verify:live-artifacts`  
Expected: every required scenario exists; the submitted Slack fixture and every LLM-produced sample have live Ollama provenance and nonzero usage; every sample manifest uses the approved live Slack content hash; all nine sections and path/stable-ID citations validate; the Slack ablation records a concrete brief difference; all eight canonical source groups pass every expected utilization stage; all required approval authorities/quorum entries are complete; trace completeness is 100%; and unauthorized artifacts contain no restricted metadata. Verification fails on any mock/replay/fake/zero-usage marker, stale Slack ingestion/index, fixture/sample hash mismatch, missing row category, or incomplete source group/stage.

- [ ] **Step 6: Commit**

```bash
git add scripts tests/contract/live-artifacts.test.ts fixtures/cato/slack artifacts/samples package.json
git commit -m "test: add live submission artifacts"
```

### Task 17: Package, Document, and Verify the Submission

**Files:**
- Create: `apps/web/Dockerfile`, `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `railway.json`, `README.md`, `docs/architecture/{technical-overview,logical-diagram,deployment-diagram}.md`, `docs/security.md`, `docs/data-dictionary.md`, `docs/evaluation.md`, `docs/demo-script.md`, `docs/presentation/slacato-15-minute.md`, `docs/known-limitations.md`
- Modify: `docker-compose.yml`, `.env.example`, `package.json`

**Interfaces:**
- Produces: one-command Docker setup, reproducible Railway production topology, complete demo and evaluation instructions.

- [ ] **Step 1: Add non-root web, API, and worker images**

Use multi-stage pnpm builds. The public unprivileged web container serves compiled React assets and reverse-proxies same-origin `/api` and SSE to the private API. It rewrites application routes—but never missing assets—to `index.html`, serves `index.html` revalidatable/no-cache, and serves hashed assets immutable. Run the compiled NestJS API and worker as separate unprivileged Node processes with init handling and graceful shutdown. Compose starts `db`, `redis`, `api`, `worker`, and `web`; migrations, record ingestion, and embedding indexing are explicit commands rather than hidden startup side effects.

- [ ] **Step 2: Write architecture and operations documentation**

Document module boundaries, deterministic workflow, transactional outbox/reconciler, invocation leases, at-least-once inference, BullMQ retry/dead-letter behavior, context budgeting without unnecessary initial-release compaction, provider capability modes, authorization-before-retrieval, authorization-lookups-versus-evidence trace separation, RRF, cross-process SSE replay, immutable category/quorum approval, exact environment variables, Ollama Cloud setup/model IDs/inference parameters, migrations, ingestion/indexing, tests, Promptfoo, logs, Docker, Railway, and troubleshooting. Create an explicit logical Mermaid diagram showing agents, orchestration, RAG, state, human approvals, guardrails, observability, and output channels, and a separate deployment Mermaid diagram showing web/API/worker, PostgreSQL/pgvector, Redis, secrets, model gateway, monitoring, and trust boundaries. The technical overview explains the production delta for scalability, high availability, monitoring, secrets, backups/retention, incident/dead-letter operations, and support ownership. `docs/security.md` explains default-deny authorization, source sensitivity, approval authority/quorum, prompt injection, unsafe language, citation authorization, log redaction, secrets, and residual risks. Railway uses a public web service and private API/worker/PostgreSQL/pgvector/Redis services, bounded pools and concurrency, health checks, backups, explicit migrations, outbox-age/queue-depth/dead-letter alerts, and retention policies. Record exact build/start commands, private targets, proxy rules, preview/custom-domain behavior, and deployed smoke tests. Vercel Workflow and Eve are documented as considered but unnecessary for this bounded workflow.

- [ ] **Step 3: Write the mandatory demo script**

Include exact persona/opportunity steps for authorized OPP-1001, authorized OPP-1002, authorized restricted OPP-1003 with every required approval authority/quorum entry, unauthorized OPP-1003 with no leakage, and the with/without-Slack impact demonstration. Include expected visible outcomes and safe failure recovery. Create `docs/presentation/slacato-15-minute.md` as the actual presentation artifact with timed sections totaling 15 minutes: business value, architecture/design choices, live provider demo, evaluation results, production failure modes/operational delta, and closing. Include slide titles, speaker notes, and exact demo transitions; slide-ready notes elsewhere do not satisfy this gate.

- [ ] **Step 4: Record limitations and Part 2 decision**

State that cross-encoder reranking is intentionally deferred. Include the exact decision: after the internal hybrid baseline evaluation, discuss whether to prototype reranking; do not implement automatically. Do not claim bonus cost-aware routing or an additional synthetic-data generator; report only implemented and verified bonus behavior.

- [ ] **Step 5: Run final clean-room verification**

Run:

```bash
docker compose down
docker compose up -d db redis
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm ingest:records
pnpm index:embeddings
docker compose up -d --build api worker web
docker compose ps
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:e2e
pnpm eval:deterministic
pnpm verify:live-artifacts
git status --short
```

Expected: every process becomes ready; direct SPA reloads for deal/run/approval/settings and unknown routes behave correctly; one real queued run crosses web → API → outbox → worker → PostgreSQL → SSE, survives a worker restart, refreshes/reconnects without event gaps, and completes deterministic approval finalization. Every command exits 0, all five demo scenarios pass, permission leakage is 0, and only intentionally generated ignored reports remain untracked. Repeat a smoke test against the deployed Railway URL.

- [ ] **Step 6: Commit**

```bash
git add apps/*/Dockerfile railway.json docker-compose.yml README.md docs .env.example package.json
git commit -m "docs: package and document SlaCato submission"
```

## Plan-Level Verification Matrix

| Requirement | Assignment IDs | Owning tasks |
|---|---|---|
| Seller-assist business principle and responsive sales UI | `ASG-PROD-01` | 11, 12, 17 |
| Four real specialized LLM agents with failure contracts | `ASG-LIVE-01`, `ASG-AGENT-01` | 7, 8, 9, 15, 16 |
| All eight provided sources plus generated Slack | `ASG-DATA-01`, `ASG-SLACK-01` | 4, 5, 6, 10, 15, 16 |
| Indexed RAG, metadata filters, grounded visible citations | `ASG-CITE-01` | 3, 4, 6, 8, 12, 14, 15 |
| Authorization before retrieval/generation/render and lookup/evidence separation | `ASG-AUTH-01` | 5, 6, 8, 9, 10, 12, 14, 15 |
| Category-specific human approval, multi-role quorum, and persistence | `ASG-HITL-01` | 3, 5, 9, 13, 15, 16 |
| Unsupported/restricted/unsafe language guardrails and review gates | `ASG-GUARD-01` | 8, 9, 12, 15 |
| Complete traces, attempts, usage, recommendations, and audit logs | `ASG-TRACE-01` | 3, 7, 9, 10, 14, 15, 16 |
| Nine brief sections and required positive/negative/partial-failure demos | `ASG-DEMO-01` | 2, 8, 9, 12, 13, 15, 16 |
| Live Ollama configuration and reviewer-verifiable artifacts | `ASG-LIVE-01`, `ASG-PROVIDER-01` | 1, 6, 7, 16, 17 |
| Logical/deployment diagrams, overview, security notes, and presentation | `ASG-DOC-01` | 16, 17 |
| Durable Docker/Railway deployment and operations | `ASG-DOC-01` | 3, 17 |
| Context budgeting with dormant, non-invoked future compactor infrastructure | `ASG-AGENT-01` | 7, 8, 9, 15 |
| Optional post-baseline reranking discussion; no unimplemented bonus claims | — | 6, 15, 17 |

## Submission Acceptance Gates

1. Exact runtime/package tuple installs, typechecks, and compiles the Ollama adapter.
2. Live probes confirm chat, embedding, dimension, normalization, and actual native-schema capability; all four schemas pass through the selected mode.
3. The binding task order has no dependency on a later task; the migration remains dimension-flexible, the live embedding profile/dimension is verified before activation, and record ingestion is separate from embedding indexing.
4. Transactional outbox recovery, BullMQ duplicate delivery, atomic step invocation, command idempotency, dead-letter handling, and concurrent start/approval behavior are specified and tested.
5. Approval binds to an immutable version/hash, uses compare-and-swap, enforces category-specific authority and complete multi-role quorum, revalidates edit-and-approve, and never runs post-approval synthesis.
6. Pricing classification occurs before indexing, unknowns fail closed, and opaque denial audit events contain no restricted metadata.
7. Claim-support rules and the untrusted-evidence envelope have explicit pass/fail behavior and adversarial fixtures.
8. Every primary route exists; deal-to-run, Runs index, approval, route-state, responsive, focus, and persona-switch journeys have acceptance tests.
9. Full-pipeline evaluation entry points and hard safety/completeness thresholds are fixed before prompt tuning.
10. Live artifact commands reject mock/replay/fake/zero-usage output, regenerate and reingest the reviewed submission Slack fixture with live Ollama provenance and row categories, bind every sample to its content hash, and cover briefs, Slack impact, complete approval quorum, trace completeness, usage, evaluation, explicit logical/deployment diagrams, security notes, and the timed presentation artifact.
11. Context policy tests prove bounded initial-release inputs and hard stop limits, and release traces prove exactly zero `ContextCompactor` calls. The already-built dormant compactor may retain isolated contract coverage but is not a live submission acceptance dependency.
12. Sanitized `source-coverage.json` hard-fails unless every one of the eight provided groups proves inventory → authorized retrieval/control → intended agent receipt → claim/section/citation, or the explicit access-permissions authorization-only rule. It also proves the live additional Slack source is synthetic, PII-free, novel, authorized, cited, and materially visible in one brief comparison.
13. Trace completeness is 100% for permitted terminal/approval runs, while denied traces contain no evidence, agent, citation, recommendation, source locator, or restricted metadata.
14. E2E covers malformed input, missing data, opaque denial, per-agent degraded/fatal behavior, multi-agent partial failure, unsafe language, incomplete/complete approval quorum, and Slack impact on desktop and mobile.
15. Documentation names exact Ollama models, inference parameters, environment variables and secret setup; the live probe and generated artifacts prove those settings were used, and the presentation is timed to 15 minutes.
