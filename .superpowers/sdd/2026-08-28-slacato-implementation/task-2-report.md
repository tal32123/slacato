# Task 2 report — Domain contracts and run state machine

## TDD evidence

### RED

Command:

```sh
pnpm vitest run tests/unit/brief-schema.test.ts tests/unit/run-state-machine.test.ts
```

Result: failed as expected before implementation. `userIdSchema` was undefined and `transitionRun` was not a function because the core package had no domain-contract exports. Three of seven tests failed; the incomplete-brief assertions also demonstrated that no valid schema was available yet.

During self-review, a focused timestamp-bound regression test was added first:

```sh
pnpm vitest run tests/unit/brief-schema.test.ts
```

Result: failed as expected. A valid ISO timestamp with an 81-character fractional-second representation was accepted, proving that `z.string().datetime()` alone did not meet the generated-string bound.

### GREEN

Commands and results:

```sh
pnpm vitest run tests/unit/brief-schema.test.ts tests/unit/run-state-machine.test.ts
# 2 files passed, 8 tests passed

pnpm typecheck
# exited 0

pnpm lint
# exited 0

pnpm vitest run
# 8 files passed, 29 tests passed

pnpm build
# exited 0; all workspace builds completed
```

## Delivered files

- `packages/core/src/domain/shared/ids.ts`: branded, prefix-validated persisted identifiers.
- `packages/core/src/domain/shared/errors.ts`: typed safe `AppError` hierarchy.
- `packages/core/src/domain/shared/result.ts`: explicit domain result union.
- `packages/core/src/domain/shared/serialized-size.ts`: reusable UTF-8 serialized byte-limit refinement.
- `packages/core/src/domain/briefs/schema.ts`: strict nine-section DealBrief and bounded specialist schemas.
- `packages/core/src/application/agents/contracts.ts`: agent-facing artifact exports.
- `packages/core/src/domain/runs/contracts.ts` and `state-machine.ts`: exhaustive status/event contracts and deterministic transition table.
- `packages/core/src/index.ts`: canonical public root exports for the workspace package convention.
- `tests/unit/brief-schema.test.ts` and `tests/unit/run-state-machine.test.ts`: domain contract coverage.

## Self-review

- Every object schema at the domain boundary is `.strict()`; no schema strips unknown keys.
- Every generated string and list is bounded, including ISO timestamps and the 128 KiB total serialized artifact/brief budget.
- Claim/citation/evidence IDs are branded and runtime-validated.
- All nine required DealBrief sections are explicit.
- `awaiting_approval + approval_granted` always enters `finalizing`; `finalizing` permits only `complete` or `fail`, so synthesis cannot be re-entered.
- Core imports only Zod and type-only domain contracts; no framework, UI, or infrastructure dependency was added.

## Concerns

None. Task 8 can build agent implementations over the exported contracts without changing their canonical shapes.

## Fix round 1 — approval reachability and immutable outputs

### RED

```sh
pnpm vitest run tests/unit/brief-schema.test.ts tests/unit/run-state-machine.test.ts
```

Result: 2 files failed, with 2 of 11 tests failing as expected. `validating + validation_requires_approval` threw `InvalidRunTransitionError`, demonstrating the missing route to `awaiting_approval`. The immutable-output test failed because `Object.isFrozen(brief)` was `false`.

### GREEN and full verification

```sh
pnpm vitest run tests/unit/brief-schema.test.ts tests/unit/run-state-machine.test.ts
# 2 files passed, 11 tests passed

pnpm typecheck
# exited 0; exported compile-time readonly assertions passed

pnpm lint
# exited 0

pnpm vitest run
# 8 files passed, 32 tests passed

pnpm build
# exited 0; all workspace builds completed
```

### Fix-round self-review

- `validation_requires_approval` is the sole validating-to-approval transition; `validation_completed` is the sole no-approval route to `finalizing`.
- Approval grant/rejection are valid only in `awaiting_approval`; `finalizing` remains complete/fail only.
- The post-parse transform deeply freezes only Zod's parsed output, with runtime coverage for the brief and all four artifact schemas; caller input remains unfrozen.
- `DeepReadonly` retains primitive branded IDs while rendering nested objects and arrays readonly. Type-level assertions are built with core and checked by `pnpm typecheck`.
