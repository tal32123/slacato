# Task 9 Report — Durable Deal Brief and Approval Workflow

## RED evidence

The required focused tests were written before production behavior. The first focused runs failed at the missing public seams:

```text
pnpm vitest run tests/unit/policy.test.ts
# 12 failed: decideApprovalRequirement was not implemented

pnpm vitest run tests/integration/workflow.test.ts
# 15 failed: StartDealBrief was not implemented
```

The tests exercise the public `StartDealBrief.execute` and `DecideApproval.execute` APIs, not test-only enqueue or parked-job APIs.

## Implementation

- Added deterministic, structured approval requirements with category, eligible authority, dependency order, distinct quorum, immutable quorum version, explicit confidence/conflict/missing-evidence gates, and candidate-created demo approver identities that have no retrieval permissions.
- Added a durable checkpointed workflow that persists the run and outbox command before retrieval or generation, fences checkpoints with invocation leases, independently checkpoints specialists, applies the degraded/fatal matrix, waits without a parked BullMQ job, and performs model-free deterministic finalization.
- Added immutable approval snapshots and per-entry CAS decisions for approve unchanged, edit-and-approve, and reject. Decisions retain original/effective payloads, canonical hashes, diffs, actor, explicit account-scoped authority, category, rationale, and time. Quorum advances only after every dependency-aware entry agrees on one effective snapshot.
- Added PostgreSQL schema/migration parity for start idempotency, absolute deadlines, stable logical generation identity, validation metadata, specialist artifacts, authoritative policy facts, explicit authority grants, approval requirement entries/decisions, and versioned briefs, including immutability triggers.
- Added PostgreSQL workflow/access/policy adapters, durable generation-attempt metadata, absolute-deadline clamping, authoritative fixture policy facts and authority grants, authenticated Nest run/approval endpoints, and a thin BullMQ worker with one initial replica, explicit concurrency/rate/lock renewal, transport-only delivery attempts, and graceful draining.
- HTTP actor identity is taken only from the authenticated session; request bodies cannot select an actor. Opportunity denial remains opaque and is audited without resource details.

## Focused verification

Passed after implementation:

```text
pnpm vitest run tests/unit/policy.test.ts
# 1 file passed, 12 tests passed

pnpm vitest run tests/integration/workflow.test.ts
# 1 file passed, 15 tests passed

git diff --check
# clean
```

The initial Task 9 pass intentionally deferred project-wide verification to the integration owner. After integration-owner feedback, the BullMQ worker's generic job name/result types were made explicit and the requested full strict typecheck was run.

## Integration-owner typecheck follow-up

Passed after the compile fix:

```text
pnpm typecheck
# exit 0

pnpm vitest run tests/unit/policy.test.ts tests/integration/workflow.test.ts
# 2 files passed, 27 tests passed
```

No formatter, lint, build, or project-wide test suite was run.

## Round-1 review hardening

Standards and security review identified authorization ordering, replay scope, full-command idempotency, distinct-person quorum, edited-snapshot grounding/policy revalidation, trusted model identity, retrieval budget accounting, recoverable BullMQ delivery, regeneration, and missing real-seam integration coverage.

The hardened implementation now:

- authorizes before start replay and approval-subject lookup, audits opaque denials, and binds replay to the complete canonical command;
- takes provider/model identity only from trusted composition and verifies persisted identity in the worker;
- reauthorizes the exact manifest scope before every model prompt;
- records retrieval embeddings in the run's durable attempt/deadline/budget ledger;
- rethrows recoverable workflow failures for BullMQ delivery and terminalizes only explicit fatal workflow errors;
- requires distinct people for Deal Desk/Sales Leader quorum;
- replaces edited approval subjects immutably, recomputes authoritative requirements, and requires fresh approval;
- reconstructs exact manifest evidence for edited snapshots, runs the production claim-support validator over the exact payload, rejects any grounding mutation, and applies conservative deterministic semantic gates for liability, retention, restricted research, customer-specific security, and customer concessions;
- exposes explicit versioned regeneration and rejects decisions against superseded subjects;
- proves the authenticated HTTP → PostgreSQL outbox → BullMQ worker → approval wait → authenticated decision → deterministic finalization path with real production adapters and no parked run job.

Focused failures during this round exposed production-only gaps before their fixes, including the absent `opportunities.stage` column, a reserved SQL alias in start authorization, the missing durable approval migration in the local test catalog, and array JSON metadata binding in the provider-attempt ledger.

Final focused evidence:

```text
pnpm vitest run tests/unit/policy.test.ts tests/integration/workflow.test.ts tests/integration/workflow-production.test.ts tests/integration/migration-catalog-parity.test.ts
# 4 files passed, 40 tests passed

pnpm vitest run tests/integration/repositories.test.ts -t "configured production composition"
# 1 test passed, 10 skipped

pnpm typecheck
# exit 0

git diff --check
# clean
```

## Round-2 review hardening

Focused RED proof reproduced all five review findings before production changes:

```text
pnpm vitest run tests/integration/workflow.test.ts tests/integration/workflow-production.test.ts
# 2 files failed; 8 failed, 18 passed
# recoverable production delivery remained stuck after the first retrieval failure
# checkpoint persistence errors resolved/degraded/terminalized instead of rethrowing
# exact regeneration and edited-decision replays failed
# unrelated Legal plus Deal Desk decisions were incorrectly actor-distinct
```

The fix explicitly abandons recoverable invocation leases without consuming their causal commands; separates specialist service-call classification from checkpoint persistence; persists and atomically replays canonical regeneration requests; scopes distinct actors to the Deal Desk/Sales Leader commercial pair; and resolves authorized decision idempotency before superseded-subject staleness.

Final round-2 focused evidence:

```text
pnpm vitest run tests/integration/workflow.test.ts tests/integration/workflow-production.test.ts
# 2 files passed, 26 tests passed
# production path proves a transient retrieval failure is reclaimed on BullMQ retry
# production path proves exact regeneration and edit-and-approve HTTP replays

pnpm typecheck
# exit 0

git diff --check
# clean
```

## Round-3 review hardening

Focused RED proof showed that replay lookup incorrectly rebound every decision on a superseded subject:

```text
pnpm vitest run tests/integration/workflow.test.ts -t "replays an unchanged|replays a rejection"
# 1 file failed; 2 failed, 25 skipped
# unchanged and rejected decisions both returned a later replacement subject ID
```

Replay now follows the original decision semantics: only `edit_and_approve` returns the replacement subject it created; `approve_unchanged` and `reject` remain bound to their original immutable subject and entry after later edit or regeneration.

Final round-3 focused evidence:

```text
pnpm vitest run tests/integration/workflow.test.ts tests/integration/workflow-production.test.ts
# 2 files passed, 28 tests passed

pnpm typecheck
# exit 0

git diff --check
# clean
```

## Round-4 replay-integrity hardening

The PostgreSQL-backed regression failed before the production change and exposed both mutable replay fields:

```text
pnpm vitest run tests/integration/workflow-production.test.ts -t "replays the original"
# 1 file failed; 2 failed, 1 skipped
# approve_unchanged replay changed quorumSatisfied from false to true and run version from 6 to 7
# reject replay changed its persisted terminal run status/version from rejected@12 to synthesizing@13 after regeneration
```

Approval decisions now persist their decision-time run version, status, quorum outcome, and rejection outcome in immutable decision rows. Replay reads those fields directly, keeps unchanged/rejected decisions bound to their original subject and entry, and allows only `edit_and_approve` to return the immediate replacement subject recorded by the original subject's immutable supersession link. Full request-hash conflicts remain checked before returning a replay.

The cumulative migration backfills existing decisions from their decision-time approval events, adds result consistency constraints, and restores the immutable-row trigger. Drizzle schema mapping and migration catalog assertions cover all four result columns.

Final round-4 focused evidence:

```text
pnpm vitest run tests/integration/workflow-production.test.ts
# 1 file passed, 3 tests passed

pnpm vitest run tests/integration/migration-catalog-parity.test.ts
# 1 file passed, 3 tests passed

pnpm typecheck
# exit 0
```
