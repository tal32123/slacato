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

Per the task constraint, no formatter, lint, build, project-wide test suite, or full typecheck was run. Project-wide validation is reserved for the integration owner after Task 9 lands.
