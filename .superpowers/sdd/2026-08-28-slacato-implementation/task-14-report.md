# Task 14 Report — Safe Logging, Audit, and Exports

## Delivered

- Added recursive, cycle-safe, JSON-safe log redaction and a Pino logger that sanitizes both log arguments and nested child bindings before serialization.
- Wired mutually exclusive structured lifecycle events at durable provider-attempt, BullMQ workflow-command, approval-decision, and brief-export boundaries.
- Added deterministic canonical JSON and escaped Markdown rendering for the complete immutable nine-section `DealBrief`, including a shared citation-label consistency gate and stable citation references and definitions.
- Added the authenticated `GET /api/runs/:runId/export/:format` route for `json` and `markdown` downloads.
- Added server-authoritative export reads from completed, finalized `briefs` rows, canonical run authorization, exact immutable run-manifest citation tuple checks, and current permission checks for every referenced evidence version.
- Added append-only `brief_exported` success events and actor-only, run-ID-free `brief_export_denied` events with generic payloads.

## RED evidence

- `pnpm exec vitest run tests/unit/redaction.test.ts` initially failed all 3 tests because `redactLogPayload` and `createSafeLogger` did not exist.
- The first feature-level `pnpm exec vitest run tests/integration/export-controller.test.ts --maxWorkers=1 --silent` run failed all 3 tests: `exportBrief` did not exist, the authorized HTTP request returned the framework 404, and opaque route responses did not match the required body.
- A later child-binding test exposed that Pino child context bypassed the argument hook and emitted both prompt and authorization sentinels. It remained RED for the authorization-header variant after child sanitization, proving both defenses independently before the key matcher was hardened.
- Citation hardening added an otherwise-readable finalized brief with no immutable run-manifest binding; the final integration suite now proves this citation-denied state is opaque alongside missing, run-denied, partial-evidence, and authority-only requests.
- Focused RED regressions separately proved the authority-only/no-reference authorization bypass, the absence of durable denial events, serialized root/nested `stack` and `cause` leakage, and JSON accepting a citation-label conflict that Markdown rejected.

## GREEN and smoke evidence

- `pnpm exec vitest run tests/unit/redaction.test.ts` — 1 file, 5 tests passed.
- `pnpm exec vitest run tests/integration/export-controller.test.ts --maxWorkers=1 --silent` — 1 file, 5 tests passed against a fresh migrated disposable PostgreSQL database.
- The integration test exercises the real Nest HTTP route through `supertest`: authenticated JSON and Markdown downloads, repeated byte-identical Markdown, parsed canonical JSON, response headers, audit rows, and opaque denied responses.
- `pnpm typecheck` — passed for web, API, worker, contracts, core, and infrastructure.

## Logging fields and redaction invariants

Provider attempt events emit stable `event`, `correlationId`, `runId`, `attemptId`, `status`, `provider`, `model`, `durationMs`, `retryCount`, `inputTokens`, `outputTokens`, and safe normalized `errorCode` fields. Workflow, approval, and export events emit the applicable stable subset and never serialize command payloads, approval rationale/diffs, brief bodies, prompts, completions, or source/evidence content.

Redaction is case- and separator-insensitive for authorization/auth/credentials, cookies, API keys, passwords, secrets, singular tokens, `msg`/`err`/`error`, messages, prompts, completions, generic bodies/content, plural source bodies/content, evidence excerpts, and serialized error stacks/causes. It handles nested objects, arrays, repeated references, real cycles, throwing getters, `Error` objects, unsupported values, non-finite numbers, and excessive depth. Error messages, stacks, and causes are always replaced; only a constrained error name and uppercase safe code can survive. Free-form Pino message strings are replaced, and child bindings are recursively sanitized before they become persistent context.

Unit sentinels for authorization, cookies, API keys, messages, prompts, completions, source bodies/content, evidence excerpts, error messages/stacks/causes, and nested child bindings are absent from emitted Pino output while run/provider/attempt/status/duration/retry/token metrics remain present.

## Export authorization, content, and headers

The export service returns content only when all of these hold in server-owned persisted state:

1. The validated run identifier resolves inside the actor's canonical run scope.
2. The run is `completed` and the selected persisted brief has `finalized_at` set.
3. Every citation ID/evidence ID/locator tuple exactly matches an immutable entry in that run's evidence manifest.
4. Every citation and source-evidence ID resolves to the same opportunity/account with a non-empty locator.
5. A current canonical source grant permits the exact persisted source type and required account/evidence sensitivity, including restricted and sensitive-pricing rules.

Canonical run access does not bypass evidence authorization: a partial reader and an approval-authority-only actor both receive the same response as an outsider, a missing run, and an unbound citation. Denied attempts create no success audit row; each appends the same actor-only durable denial event with `run_id = null` and no probed resource identifier. Neither responses nor durable denial payloads reveal citation, evidence, permission, authority, brief, count, filename, or disposition detail.

JSON uses canonical key ordering and parses to the canonical `DealBrief`. Markdown is deterministic, escapes Markdown/HTML-significant input, renders exactly all nine numbered sections, and provides stable footnote-style citation labels. A single pre-format validation rejects conflicting citation-label tuples identically for JSON and Markdown. Neither format reads or exports raw `document_versions.content` or `evidence_versions.content`; tests seed source/evidence sentinels and prove their absence.

Successful responses set:

- JSON: `application/json; charset=utf-8`, `.json`
- Markdown: `text/markdown; charset=utf-8`, `.md`
- `Content-Disposition: attachment` with a validated and sanitized run-derived filename
- `Cache-Control: private, no-store`
- `X-Content-Type-Options: nosniff`
- a generated safe `X-Correlation-Id`

Encoded CRLF/header-injection input is rejected before download headers are constructed.

## Changed files

- `packages/infrastructure/src/logging/logger.ts`
- `packages/infrastructure/src/logging/redaction.ts`
- `packages/infrastructure/src/db/repositories/provider-attempt-ledger.ts`
- `packages/infrastructure/src/index.ts`
- `packages/core/src/application/briefs/exports.ts`
- `packages/core/src/index.ts`
- `apps/api/src/modules/exports/exports.controller.ts`
- `apps/api/src/modules/exports/exports.service.ts`
- `apps/api/src/modules/exports/exports.module.ts`
- `apps/api/src/modules/approvals/approvals.controller.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/main.ts`
- `apps/worker/src/processors/deal-brief.processor.ts`
- `tests/unit/redaction.test.ts`
- `tests/integration/export-controller.test.ts`
- `.superpowers/sdd/2026-08-28-slacato-implementation/task-14-report.md`

## Risks and scope

- Exports intentionally contain approved brief narratives, authorized evidence summaries, and authorized citation locators; they intentionally exclude raw source/evidence bodies and model inputs/outputs.
- Markdown is a deterministic internal export, not an HTML renderer. Markdown metacharacters are escaped so downstream renderers cannot reinterpret brief text as headings, links, or raw HTML.
- No Task 15 evaluation work or Task 17 documentation/deployment work was added.
- The six pre-existing unrelated documentation changes remained untouched and are excluded from the Task 14 commit.
