# Task 13 Report — Runs, Reconnect, and Approval Experiences

## Delivered

- Added typed run start/list/detail and approval inbox/detail/decision contracts.
- Added scoped run and approval query controllers backed by safe PostgreSQL projections. Requesters require canonical readable grants; approval actors may access only subjects covered by an explicit matching approval-authority grant. Unauthorized and missing identifiers share the same opaque response.
- Added the deal-owned Generate Brief action with a stable client operation key, disabled pending state, safe retry, typed create-then-redirect behavior, and canonical cache invalidation.
- Added `/runs`, `/runs/:runId`, `/approvals`, and `/approvals/:subjectId` routes with active, awaiting, completed, rejected, failed, empty, reconnecting, offline, stalled, and retryable states.
- Added reconnectable SSE handling that validates every envelope, ignores sequences at or below the persisted watermark, requires the matching run and current session generation, and conditionally closes/invalidate caches on terminal or approval transitions.
- Added a single atomic polite live-phase announcement; specialist, retrieval, validation, completed-section, and persisted timeline detail remains outside the live region.
- Added authority-scoped pending/history approval UX with quorum progress, age, assignment, evidence/run links, approve unchanged, edit and approve, and reject actions. Decisions submit immutable subject hash and current run version CAS coordinates. Editing creates a replacement subject and does not resume the run; partial quorum remains awaiting; rejection is terminal.
- Kept raw prompts, hidden reasoning, secrets, source excerpts, and restricted evidence content out of all new query projections and UI.

## TDD and verification evidence

### Red evidence

- Contract tests initially failed because the new run and approval schemas did not exist.
- Stream tests initially failed because the validated generation-aware run stream module did not exist.
- API integration tests initially returned 404 for the new list/detail endpoints; an additional RED removed the approver's evidence grant and exposed the approval-authority/SSE authorization seam.
- The first isolated Playwright run exposed three fixture/behavior issues: one-active-run fixture collision, canonical opportunity leakage into an existing deal test, and navigation occurring before the offline assertion. Subsequent RED runs exposed a noncanonical persona switch, missing immutable evidence manifest, ungrounded edit fixture, and an ambiguous terminal locator. Each failure was fixed at its source or in the isolated fixture.

### Green evidence

- `pnpm vitest run tests/unit/run-approval-contracts.test.ts tests/unit/run-stream.test.ts tests/integration/run-approval-api.test.ts` — 3 files, 9 tests passed.
- `pnpm vitest run tests/integration/sse-controller.test.ts` — 1 file, 15 tests passed.
- `docker compose up -d redis` followed by `pnpm vitest run tests/integration/workflow-production.test.ts` — 1 file, 3 tests passed, exercising authenticated API, PostgreSQL outbox, BullMQ, approval wait/quorum, and deterministic finalization.
- `DATABASE_URL=postgres://slacato:slacato@127.0.0.1:54329/slacato_task13_1788011256644 pnpm exec playwright test tests/e2e/run-resume.spec.ts tests/e2e/approval.spec.ts` — 7 browser tests passed. Coverage includes single submit/stable redirect, persisted watermark refresh, offline/reconnect, persona transition and opaque run links, partial quorum with distinct authorities, edit replacement without resume, terminal rejection, mobile layout, and automated accessibility checks.
- `pnpm typecheck` — passed for web, API, worker, contracts, core, and infrastructure.

## Browser findings

A real Chromium session was driven against the built API and web application using the isolated Task 13 database. The authorized Rina Vale approval inbox rendered one pending replacement subject before three historical decisions. Desktop (1440 × 1000) and mobile (390 × 844) both had zero horizontal overflow. The mobile surface collapsed navigation and preserved pending-first stacked cards, authority, quorum, assignment, age, and decision/run links. Full-page screenshots were captured during verification. Playwright also exercised the run and approval pages in Chromium at desktop and mobile sizes with no automated accessibility violations.

## Invariants and decisions

- Persisted detail is loaded before SSE; the persisted watermark is included in the subscription URL.
- An SSE event may update state only when its envelope validates, run ID matches, sequence is newer, and session generation is current.
- Terminal ownership closes only the matching stream and invalidates the canonical deal/run/index/approval keys.
- Approval permission and evidence-read permission remain separate: explicit authority enables safe approval/run context, but does not grant deal/evidence access.
- Approval edits are revalidated against the immutable run evidence manifest and structured policy facts before a replacement subject is created.
- E2E fixtures use isolated personas/accounts/opportunities and one active run per opportunity, leaving canonical demo scenarios unchanged.

## Environment note

The shared development database had schema through migrations 0014–0016 but its Drizzle journal ended at 0013 because earlier focused tests installed schema directly. Browser verification therefore used fresh disposable PostgreSQL databases so `db:migrate` could apply the complete journal deterministically. The production workflow test initially reproduced an unavailable isolated Redis port; starting the declared Compose Redis service made the unchanged workflow test pass.

## Review hardening — round 1

- Added server-authoritative PostgreSQL session registration and revocation. Persona switches and logout now revoke the prior signed session version, and retained SSE connections reauthorize the session and canonical run scope before cursor reads, polling pages, event writes, resync instructions, and heartbeats.
- Added explicit canonical provenance to approval-authority grants. Start, list/detail, approval decisions, worker retrieval, snapshot, and SSE boundaries now accept only the canonical fixture commit; the migration removes grants whose provenance cannot be established, and ingestion recreates the declared canonical grants.
- Made existing active-run reuse readable to every canonically authorized opportunity reader, kept missing and unauthorized mutation responses opaque and indistinguishable, and projected completed sections only from successful validation checkpoints or persisted approval subjects.
- Added safe capability projections for deal and individual evidence links, actual decision authority in approval history, structured persisted approval diffs, semantic edit controls, before/after preview and quorum impact, local contract validation, exact field errors/focus, 4,000-character rationale enforcement, preserved operation keys for retry, a distinct 409 reload path, action-specific busy labels, and focused atomic success announcements.
- Added milestone REST reconciliation, explicit online reconnect, truthful stopped progress for rejected/failed runs, native progressbar value semantics, title-cased statuses, rejected-history treatment, descendant navigation state, per-route titles/focus, opaque error focus, and removal of internal sequence metadata from the primary UI.
- Expanded approval browser coverage with run detail refresh, forced reconnect/reload recovery, desktop detail accessibility, semantic edit preview, 320-pixel reflow, and opaque deep-link checks.

### Review verification evidence

- Fresh PostgreSQL databases migrated through `0017_canonical_grants_sessions.sql`; canonical ingestion succeeded with 6 personas, 51 grants, 3 accounts, 3 opportunities, 15 contacts, 74 documents, and 136 chunks.
- `pnpm exec vitest run tests/unit/run-stream.test.ts tests/unit/run-approval-contracts.test.ts tests/unit/run-state-machine.test.ts` — 3 files, 11 tests passed.
- `pnpm exec vitest run tests/integration/run-approval-api.test.ts --maxWorkers=1` — 1 file, 4 tests passed.
- `pnpm exec vitest run tests/integration/sse-controller.test.ts --maxWorkers=1` — 1 file, 16 tests passed, including retained raw-stream revocation on persona switch and logout.
- `pnpm exec vitest run tests/integration/workflow-production.test.ts --maxWorkers=1` — 1 file, 4 tests passed, including worker-side stale-provenance denial.
- `pnpm exec vitest run tests/integration/migration-catalog-parity.test.ts --maxWorkers=1` — 1 file, 3 tests passed.
- `pnpm exec playwright test tests/e2e/approval.spec.ts --workers=1` — 4 browser tests passed.
- Focused TypeScript checks passed for web, API, worker, and infrastructure after building changed contracts/core/infrastructure.

### Review browser findings

A real Chromium session was driven against the built application and a fresh migrated database. The desktop approval inbox showed pending decisions before history, actual authority, quorum, assignment, age, and distinct rejected styling. The semantic approval editor showed bounded executive-summary, negotiation-state, confidence, rationale, before/after preview, and quorum effect without exposing internal payload JSON. At 320 × 700, the approval inbox had `scrollWidth === clientWidth === 320`; cards and controls reflowed without horizontal overflow. An opaque missing approval focused its error surface and set the title to `Unavailable view | SlaCato`.

## Review hardening — round 2

- Tightened approval evidence capabilities to persisted `evidence_versions` only. A projected evidence link now requires an exact payload ID match, account and opportunity ownership, non-empty source locator, canonical grant provenance, matching persisted source type, and the required standard/restricted/sensitive-pricing permission.
- Reordered approval decisions so canonical account authority and the exact eligible subject entry are verified before request-hash replay, hash mismatch, category, or CAS checks. Unauthorized, missing, and fresh superseded subjects remain opaque and indistinguishable, while an authorized stale subject hash still returns a reloadable conflict. Identical authorized replays remain idempotent.
- Completed the validated brief with all nine review sections, guided empty states, and capability-gated evidence links. The editor now enforces the contract's exact 8,000-character executive-summary and negotiation-state bounds, maps structured validation issues to the correct field, and focuses the first invalid control.
- Moved durable decision success and focus ownership outside the mutable-subject branch. Success is recorded before cache invalidation, survives replacement navigation, is announced once, and distinguishes partial quorum, satisfied quorum, and rejection.
- Made approval detail status outcome-aware: quorum-satisfied subjects show Finalizing, rejected and failed subjects use attention styling, completed runs show Ready, and the remaining immutable states stay read-only.
- Expanded browser coverage for progress semantics, reconnect/reload recovery, all approval sections, keyboard-only approve/edit/reject decisions, exact field-error focus, duplicate submission disablement, safe 409 reload and transport retry, partial quorum, durable replacement success, rejection, 320-pixel reflow, accessibility, and opaque run/approval/deal/evidence deep links after a persona change.

### Round 2 red evidence

- The hardened approval API test initially failed when a fixture's evidence provenance was incomplete, then when its IDs violated the contract's normalized identifier shape. Completing the persisted provenance and using contract-valid IDs exposed and verified the intended capability boundary.
- The expanded browser suite initially exposed a premature persona-transition assertion and strict-locator ambiguity for multiple status regions. The test now waits for the new authenticated persona and scopes durable decision status precisely.

### Round 2 verification evidence

- `pnpm exec vitest run tests/unit/run-stream.test.ts tests/unit/run-approval-contracts.test.ts tests/unit/run-state-machine.test.ts` — 3 files, 11 tests passed.
- `pnpm exec vitest run tests/integration/run-approval-api.test.ts --maxWorkers=1` — 1 file, 5 tests passed, including persisted evidence capabilities and the authority-first opaque/conflict matrix.
- `pnpm exec vitest run tests/integration/sse-controller.test.ts --maxWorkers=1` — 1 file, 16 tests passed.
- `pnpm exec vitest run tests/integration/workflow-production.test.ts --maxWorkers=1` — 1 file, 4 tests passed.
- `pnpm exec playwright test tests/e2e/run-resume.spec.ts tests/e2e/approval.spec.ts --workers=1` — 7 Chromium tests passed.
- `pnpm typecheck` — passed for web, API, worker, contracts, core, and infrastructure.

### Round 2 browser findings

A real Chromium session was driven against the built application and fresh round-2 database. At 1440 × 1000, approval detail visibly rendered Deal snapshot, Executive summary, Buyer goals and business drivers, Stakeholder map, Negotiation state, Recommended next actions, Missing information, Authorized evidence summaries, and Confidence and review warnings. At 320 × 700, the open semantic editor had `scrollWidth === clientWidth === 320`; the full surface and controls reflowed without horizontal overflow. Separate immutable detail checks showed Finalizing with the neutral dashed-circle treatment and Rejected with attention styling rather than a misleading locked state. A missing approval set `Unavailable view | SlaCato` and focused its `role="alert"` section.
