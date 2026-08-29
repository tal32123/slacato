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
