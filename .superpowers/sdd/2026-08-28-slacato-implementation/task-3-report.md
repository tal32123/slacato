# Task 3 report — durable PostgreSQL persistence

## RED evidence

Before adding schema or persistence production code, I wrote
`tests/integration/repositories.test.ts`. The test asserts that a newly
created `runs` record is visible with `created` status and that no generation
attempt exists yet. A broken implementation that writes an attempt before the
run, or fails to persist the run, makes this test fail.

On 2026-08-28 the focused command was RED as expected because no local
database service was running:

```text
pnpm test:integration -- repositories.test.ts
# 1 test failed
# connect ECONNREFUSED 127.0.0.1:54329
```

I then created `docker-compose.yml` with named PostgreSQL and Redis volumes,
health checks, PostgreSQL `pgvector/pgvector:0.8.1-pg17`, and Redis AOF with
`maxmemory-policy=noeviction`. Before creating or touching any volume I
inspected Docker state. Docker itself is unavailable in this workspace:

```text
docker compose up -d db redis
# Cannot connect to the Docker daemon at unix:///Users/Tal/.docker/run/docker.sock
```

Once Docker Desktop was available, I re-inspected the empty Compose state and
created only the two named service volumes. Both services reported healthy.
The exact post-Compose RED proof then failed before migration as required:

```text
pnpm test:integration -- repositories.test.ts
# 2 tests failed
# PostgresError: relation "personas" does not exist
# expected [] to deeply equal [{ atttypmod: -1 }]
```

No volume or data was removed or reset. GREEN evidence follows only after the
database migration and queue adapter tests pass.

## GREEN verification

`pnpm db:migrate` applied `0000_initial` and the compatibility follow-up
`0001_delivery_claim_leases`; a second migration run completed cleanly. The
integration suite uses the live Compose PostgreSQL, pgvector extension, Redis,
and BullMQ queue:

```text
pnpm test:integration -- repositories.test.ts outbox-queue.test.ts
# 2 files passed, 12 tests passed
```

The integration contracts cover run-before-attempt persistence, bare-vector
typmod and generated lexical index catalog checks, immutable manifest entries,
complete embedding-profile filtering before exact cosine ranking, persisted
`attempt_started`/possible-duplicate accounting, transaction-outbox recovery,
duplicate delivery, dispatcher contention, claimed-command recovery, terminal
job reconciliation suppression, lease takeover and stale-holder rejection,
cross-run approval-subject rejection, and redacted dead-letter inspection.

Final project verification on 2026-08-28:

```text
pnpm lint
pnpm typecheck
pnpm test        # 17 files passed, 99 tests passed, 1 opt-in live test skipped
pnpm build
git diff --check
```

## Recovery hardening RED evidence (fix round 1)

Before modifying the existing persistence implementation, I added
`tests/integration/recovery.test.ts` to name three regressions: a failed
BullMQ job must not be treated as successful completion, a transient polling
error must not permanently stop the dispatcher, and a `startRun` command may
not target a different run. The focused RED command is recorded after it is
run; the tests exercise the live disposable PostgreSQL service and only a
test-local loop double for the transient failure.

The focused RED command failed as expected on 2026-08-28:

```text
pnpm vitest run tests/integration/recovery.test.ts
# failed jobs were left published (0 rows restored)
# the first polling error escaped as an unhandled rejection and no second poll ran
```

## Recovery hardening GREEN verification (fix round 1)

- BullMQ now distinguishes `completed`, `failed`, `live`, and `missing`; failed
  command IDs are deliberately retried in place, while completed IDs remain
  retained and are not reconciled as missing.
- Dispatcher and reconciler loops report a generic transient failure through an
  injected safe hook, use a bounded backoff, and always schedule the next poll
  unless shutdown has begun.
- Workflow commands are run-bound and idempotency collisions are verified by
  ID, run, type, key, and canonical payload. Leases carry a causal command ID
  and a lease token; commit consumes the causal outbox row atomically.
- Approval finalization is discriminated: non-rejections require a same-run
  continuation; rejections cannot enqueue one. Composite database linkage
  prevents a brief from attaching a foreign run/hash approval snapshot.
- The exact-cosine adapter now joins grants and applies access/profile/nonzero
  filters before distance ordering. Run-budget rows and reservations provide a
  restart-safe budget seam for Task 9/Task 7 composition.

Verification after the fix: focused integration suites passed 3 files / 15
tests; the full suite passed 18 files / 103 tests with 1 opt-in live test
skipped. Lint, typecheck, build, repeat migration, and `git diff --check`
passed.

## Close-races RED evidence (fix round 2)

Added an integration regression that claims two different step names against
the same published causal command. The current implementation permits both,
which proves that command-row locking alone does not retain an active-command
exclusion after the claim transaction commits.

GREEN: command-specific active lease locking plus a partial unique index now
reject the second cross-step claim. The reconciler's restore update includes a
fresh consumed/live-or-completed causal-invocation predicate. Focused suites
passed 2 files / 10 tests; full verification passed 18 files / 104 tests with
1 opt-in live test skipped, plus lint/typecheck/build/repeat migration/diff.

## Exhausted processor DLQ RED/GREEN evidence (fix round 2 blocker B)

RED: I added a live Redis/BullMQ integration case which publishes through the
transactional outbox, lets a real BullMQ `Worker` throw until its three
configured attempts are exhausted, then invokes reconciliation. It failed as
expected before the change:

```text
pnpm vitest run tests/integration/outbox-queue.test.ts
# expected outbox status dead_letter
# received pending
```

A second RED case used BullMQ's real `UnrecoverableError`; the job had
`attemptsMade: 1`, `maxAttempts: 3`, but had already been declared
non-retryable. The old inspector reported `exhausted: false`.

GREEN: BullMQ inspection now exposes state, attempts made, maximum attempts,
and a safe exhausted boolean. The queue only manually retries failed jobs that
remain retryable. Reconciliation atomically token-claims a genuinely exhausted
published command as `dead_letter_claimed` only while it remains unconsumed and
has no live or committed causal invocation. It then writes exactly one stable,
retained job to the dedicated DLQ with a redacted payload containing only the
command ID/type, `processor_attempts_exhausted`, and counts, and token-CASes
the outbox to `dead_letter`.

The real integration tests also cover an actual completed-and-consumed job,
unrecoverable failure, redaction, retained DLQ inspection, and both crash
windows: after the durable claim before publish, and after BullMQ accepts the
stable DLQ job before the database acknowledgement. Re-running reconciliation
recovers both windows without returning exhausted work to primary pending or
creating a second DLQ job.

Focused GREEN verification completed:

```text
pnpm vitest run tests/integration/outbox-queue.test.ts tests/integration/recovery.test.ts
# 2 files passed, 17 tests passed
```

## Migration catalog parity RED/GREEN evidence (fix round 2 blocker E)

RED: `tests/integration/migration-catalog-parity.test.ts` first compared the
historical base migration with `5b89dce`. It failed because later delivery,
causal-command, approval-link, and restricted-grant changes had been edited
into `0000_initial.sql`:

```text
pnpm vitest run tests/integration/migration-catalog-parity.test.ts
# expected 0000_initial.sql to equal 5b89dce:drizzle/0000_initial.sql
# diff included can_read_restricted, causal_command_id,
# approval_subjects_id_run_hash_uq, and briefs_approval_subject_snapshot_fk
```

GREEN: restored `0000` and preserved `0001` byte-for-byte from `5b89dce`.
The new live PostgreSQL catalog test creates two exact, UUID-suffixed
`catohw_catalog_` databases, validates the prefix before every create/drop,
applies `0000..0008` cleanly to one and `0000..0001` then `0002..0008` to the
other, and drops only those exact databases in `finally`. It normalizes and
compares public tables, columns/types/typmods/defaults/generated flags,
constraints (including FKs, unique and checks), indexes, and extensions. It
also asserts pgvector, bare vector typmod `-1`, generated lexical tsvector,
the profile/vector-dimension check, approval link, active causal index,
budget/ledger fields, and no HNSW.

`schema.ts` now maps the final runtime shape (including the full vector tuple
check, numeric claim confidence bounds, JSON policy-trigger array, composite
approval link, claims/lease/outbox constraints, and budget reservation ledger
columns and uniqueness). Migrations remain canonical for immutable triggers
and pgvector SQL invariants; the runtime mapping is not used to regenerate
historical migrations.

Focused GREEN verification:

```text
pnpm db:migrate && pnpm db:migrate
# both completed successfully
pnpm vitest run tests/integration/migration-catalog-parity.test.ts
# 1 file passed, 2 tests passed
pnpm vitest run tests/integration/repositories.test.ts
# 1 file passed, 7 tests passed
pnpm vitest run tests/integration/outbox-queue.test.ts
# 1 file passed, 11 tests passed
pnpm vitest run tests/integration/recovery.test.ts
# 1 file passed, 6 tests passed
```
