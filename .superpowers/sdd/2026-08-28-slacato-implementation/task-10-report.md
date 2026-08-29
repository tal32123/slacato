# Task 10 Report — Append-Only Traces and Resumable SSE Progress

## RED evidence

The focused tests were written before production behavior. The first unit run failed all seven cases because the generic subscription, safe event contracts, and trace completeness APIs did not exist:

```text
pnpm vitest run tests/unit/event-bus.test.ts
# 1 file failed, 7 tests failed
```

The real PostgreSQL/Nest integration test then failed at the missing production persistence and route seams. After the fixture harness was corrected, the RED run exposed the absent event-version column and per-run replay constraint before the Task 10 migration and store were implemented.

The tests exercise public contracts and real boundaries: `RunEventBus.subscribe`, `PostgresEventStore`, PostgreSQL `LISTEN`/`NOTIFY`, raw Nest HTTP SSE, authenticated run authorization, Task 9 workflow persistence, and `assertTraceComplete`.

## Implementation

- Added one strict event/trace contract family with PostgreSQL sequence, typed cursor/snapshot/resync instructions, bounded safe JSON payloads, forbidden secret/prompt/body/locator fields, linked trace/span/parent IDs, and typed trace kinds/statuses.
- Added the generic, deal-rule-free `RunEventBus`, a race-free replay loop that arms wakeups before reads, deduplicates by authoritative per-run sequence, isolates streams, stops on abort, and periodically re-reads PostgreSQL so a dropped notification cannot create a gap.
- Added `PostgresEventStore` with transactional advisory-lock sequence allocation, idempotent publishing, cursor resolution, paged replay, dedicated lifecycle-managed PostgreSQL listening, wakeup fanout, safe append-only trace persistence, and persisted approval requirement/decision cross-checks.
- Added deterministic trace completeness verification for permitted completed and awaiting-approval runs, all specialist/strategy/model/validation/guardrail/usage stages, policy/recommendation/finalization, linked approval requirements and decisions, linked degraded/fatal outcomes, and safe denial-only traces. Authorization lookups are explicitly distinct from evidence retrieval and never count as evidence.
- Added migration `0016_append_only_run_observability` and Drizzle parity for trace identity/linkage/step/attempt, versioned run events, replay indexes, denied-run trace support, and database-enforced append-only trace/event/audit rows.
- Instrumented the durable Task 9 workflow transaction boundary to publish validated safe progress events and PostgreSQL notifications atomically with state changes. It now emits redacted authorization, retrieval IDs/scores, specialist/strategy attempt, model parameter hash, validation/repair, guardrail, usage, partial/fatal, policy, recommendation, approval, and finalization spans without prompts, source bodies, locators, or reasoning.
- Added safe denied-start tracing before a run exists, with correlation-only data and no run event, resource ID, evidence, agent, citation, recommendation, or locator facts.
- Added authenticated snapshot and raw SSE routes with exact proxy-safe framing and headers, strict query/header cursor validation, `Last-Event-ID` precedence, opaque authorization, strict-after replay, heartbeats, backpressure handling, typed cursor-expiry resync without an SSE ID, terminal close, and clean abort.
- Composed the event store/query through the existing API runs module and main composition root, and linked the new workspace contracts dependency without introducing a second event convention.

## Focused verification

Fresh final evidence:

```text
pnpm vitest run tests/unit/event-bus.test.ts --reporter dot --silent
# 1 file passed, 8 tests passed

pnpm vitest run tests/integration/sse-controller.test.ts --reporter dot --silent
# 1 file passed, 10 tests passed
# Covers snapshot race, reload/native cursor precedence, duplicates, cross-run isolation,
# expired resync, opaque access, heartbeat/abort, deliberately dropped NOTIFY recovery,
# worker connection/two API replicas, Task 9 transactional events, complete and denied traces.

pnpm vitest run tests/integration/migration-catalog-parity.test.ts --reporter dot --silent
# 1 file passed, 3 tests passed

pnpm typecheck
# exit 0 across apps/web, apps/api, apps/worker, packages/contracts, packages/core, packages/infrastructure
```

The package `test:integration` script currently does not narrow Vitest to its trailing filename argument and therefore starts unrelated integration files; the focused Task 10 PostgreSQL suite was run directly with the equivalent Vitest file filter shown above.

No formatter, lint, build, or project-wide/full test suite was run.
