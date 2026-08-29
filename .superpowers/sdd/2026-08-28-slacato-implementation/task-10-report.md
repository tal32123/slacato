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

## Review hardening — round 1

Standards and security review produced eleven Important findings. Focused RED proof first reproduced the wire and completeness defects:

```text
pnpm vitest run tests/unit/event-bus.test.ts --reporter dot --silent
# 1 file failed; 3 failed, 6 passed
# accepted CR/LF event IDs, camelCase sensitive payload aliases/value tunneling,
# empty per-kind trace data, and a degraded attempt without a partial decision
```

The hardened implementation now:

- assigns every denied authorization attempt a separate correlation-specific trace/run identity, so a later authorized retry cannot inherit a denial, and rejects deterministic trace-ID reuse with different content;
- applies the same line-safe opaque ID grammar at publish, persistence, replay, cursor, and frame boundaries;
- replaces blacklist-only records with strict discriminated event and trace schemas, exact payload keys, hash/enum/identifier value shapes, and required per-kind retrieval, model, validation, guardrail, policy, approval, recommendation, usage, failure, and finalization facts;
- reauthorizes before every event emission and closes an established stream without bytes after permission revocation;
- returns HTTP 204 when an authorized client reconnects at a terminal snapshot watermark, preventing native `EventSource` reconnect/poll loops;
- uses one bounded reconciliation timer per store rather than one timer per subscriber, plus per-actor and per-actor/run stream limits;
- emits model-call, validation, guardrail, repair, and usage spans for every durable generation-attempt ordinal, creating a durable checkpoint attempt when a production service has no provider-ledger row;
- requires every degraded attempt to own a linked typed partial decision and every failed attempt to own a linked fatal decision;
- serializes event and coalesced heartbeat frames through one backpressure-aware writer and explicitly removes the losing drain/close listener;
- exercises persisted production-store completed/degraded, awaiting-approval, failed, and denied-then-authorized traces; and
- preserves Task 9 production workflow behavior under the stricter event and trace boundaries.

Fresh round-1 evidence:

```text
pnpm vitest run tests/unit/event-bus.test.ts --reporter dot --silent
# 1 file passed, 9 tests passed

pnpm vitest run tests/unit/wire-boundary.test.ts --reporter dot --silent
# 1 file passed, 13 tests passed

pnpm vitest run tests/integration/sse-controller.test.ts --reporter dot --silent
# 1 file passed, 15 tests passed

pnpm vitest run tests/integration/workflow-production.test.ts --reporter dot --silent
# 1 file passed, 3 tests passed

pnpm vitest run tests/integration/migration-catalog-parity.test.ts --reporter dot --silent
# 1 file passed, 3 tests passed

pnpm typecheck
# exit 0
```

## Review hardening — round 2

The re-review found that a fatal decision created after a completed generation attempt was linked directly to that completed attempt. Completeness only examined attempts whose status was already failed, so the real validation-failure trace was rejected while other malformed fatal links could escape the intended relationship.

RED proof changed the fatal fixture to the real completed-strategy parent and reproduced the defect:

```text
pnpm vitest run tests/unit/event-bus.test.ts --reporter dot --silent
# 1 failed, 8 passed
# TraceCompletenessError: Trace is missing conversation specialist attempt
```

`failRun` now preserves the completed attempt and appends a distinct failed triggering attempt beneath it, followed by the fatal decision. Failure reasons use an exact supported-code map and select the matching specialist or strategy operation. Completeness validates every fatal span, requires failed status and a linked failed specialist/strategy attempt, rejects fatal links directly to completed attempts, and still requires every failed attempt to own a fatal decision. The PostgreSQL integration now runs the Task 9 sequence through a completed strategy checkpoint and a subsequent `draft_validation_failed`, proving the completed history, failed trigger, and fatal child all persist and pass completeness.

Fresh round-2 evidence:

```text
pnpm vitest run tests/unit/event-bus.test.ts --reporter dot --silent
# 1 file passed, 9 tests passed

pnpm vitest run tests/integration/sse-controller.test.ts --reporter dot --silent
# 1 file passed, 15 tests passed

pnpm vitest run tests/integration/workflow-production.test.ts --reporter dot --silent
# 1 file passed, 3 tests passed

pnpm typecheck
# exit 0
```
