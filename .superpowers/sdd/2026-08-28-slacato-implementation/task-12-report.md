# Task 12 Report — Authorized Deal, Brief, and Evidence Workspace

## Outcome

Implemented the Task 12 vertical slice end to end. The signed persona now receives only database-query-authorized deals, opens a strict Zod-validated brief-first workspace, inspects repository-relative citations and stable record IDs, and uses a responsive evidence surface that preserves the Task 11 session-generation, query-key, overlay-teardown, route-loader, and opaque-error invariants.

The workspace intentionally stops before Task 13. It renders source-backed preparation and persisted latest-run status when present; it does not add run controls, approvals, customer-facing output, or autonomous actions.

## RED evidence

### Deal UI and disclosure boundary

Command on a fresh disposable PostgreSQL database:

```text
DATABASE_URL=postgres://slacato:slacato@127.0.0.1:54329/slacato_task12_a216d89a2edc40efb2c3a1596a4eeb68 \
  pnpm exec playwright test tests/e2e/deals.spec.ts tests/e2e/no-leak-ui.spec.ts --workers=1
```

Initial result after migration and canonical ingestion:

```text
Running 6 tests using 1 worker
2 failed, 4 did not run
```

The first authorized and unauthorized journeys both failed at the missing `Authorized deals` surface. The Task 11 placeholder contained no list, workspace, citations, responsive evidence detail, or opaque direct-deal handling.

### HTTP projection

```text
DATABASE_URL=… pnpm exec vitest run tests/integration/deals-api.test.ts
3 failed
```

All three tests reached the real authenticated API and received the expected pre-feature `404` for `/api/deals` and `/api/deals/:opportunityId`.

### Concurrent workspace reads

```text
pnpm exec vitest run tests/unit/deals.service.test.ts
1 failed
```

The barrier-backed repository observed only `run` before release. The opportunity, stakeholder, and supplemental evidence reads had not started, proving the first workspace implementation fetched independent sections sequentially.

## Implementation

### Strict deal contracts

- `packages/contracts/src/deals.ts`
  - strict `DealListItem`, list-response, workspace, brief-section, stakeholder, action, warning, and evidence schemas
  - ISO date and offset-aware ISO datetime response fields
  - bounded arrays and text fields
  - raw source types limited to the canonical authorized set
- `packages/contracts/src/index.ts`
  - exports the Task 12 public response contracts

### Query-boundary authorization and API

- `apps/api/src/modules/deals/contracts.ts`
  - explicit repository seam, evidence scope, row types, and module options
- `apps/api/src/modules/deals/deals.repository.ts`
  - authorized list query filters account scope and restricted opportunities inside SQL
  - authorized workspace target query returns no target metadata unless the persona scope permits it
  - evidence SQL applies account, opportunity, source-type, restricted-evidence, and sensitive-pricing filters before rows leave PostgreSQL
  - latest-run and categorized evidence readers support independent fan-out
- `apps/api/src/modules/deals/deals.service.ts`
  - `listAuthorizedDeals(session)` and `getAuthorizedDealWorkspace(session, opportunityId)`
  - identical opaque denial for hidden and nonexistent opportunities
  - `Promise.all` starts latest-run, opportunity, stakeholder, and supplemental reads concurrently after the authorized target is established
  - validates the final workspace contract before returning
  - derives all visible brief facts from authorized canonical records; no hidden-source fallback
  - produces all nine brief sections plus stakeholders, actions, warnings, confidence, and account-team-update impact
  - binds every section citation to an evidence ID present in the authorized response
- `apps/api/src/modules/deals/{deals.controller,deals.module}.ts`
  - protected `GET /api/deals`
  - protected `GET /api/deals/:opportunityId`
  - strict request-param and response wire contracts
- `apps/api/src/{app.module,main}.ts`
  - composes the deal module with the shared bounded database client

### Query services and routes

- `apps/web/src/api/client.ts`
  - same-origin credentialed, contract-parsed list and workspace requests
- `apps/web/src/features/deals/queries.ts`
  - TanStack Query ownership
  - `['scoped', sessionVersion, resource]` keys
  - session-version and connection-generation fencing with authoritative reconciliation
- `apps/web/src/routes/deals.tsx`
  - protected loader and one bounded reconciliation retry
  - designed authorized-list and empty states
- `apps/web/src/routes/deal.tsx`
  - protected deep-link loader
  - evidence query parameter is the selected state
  - first selection adds one history entry; replacement selections use `replace`; Back closes the single detail surface
  - invalid evidence IDs are removed without rendering an invented record
  - Task 11 overlay teardown closes the evidence surface on session transitions
- `apps/web/src/main.tsx`, `apps/web/src/routes/root.tsx`
  - clean route cutover from the Task 11 Deals placeholder

### Brief-first responsive surface

- `apps/web/src/features/deals/deal-list.tsx`
  - semantic desktop table with caption and headers
  - complete stacked mobile records rather than hidden or squeezed columns
- `apps/web/src/features/briefs/deal-brief.tsx`
  - identity header, access/status badges, four metrics, all nine named sections
  - semantic stakeholder and action tables on desktop
  - complete stakeholder and action records on mobile
  - warnings and explicit `Account-team update impact` markers
  - real citation controls whose visible text and accessible names include `source=<repository-relative path>, <stable key>=<stable ID>`
- `apps/web/src/features/briefs/evidence-detail.tsx`
  - desktop: non-modal complementary region only when the measured content container can preserve a 640px main column; width remains 360–440px; focus enters and returns deterministically without trapping; panel scrolls independently
  - constrained and mobile: modal full-height Sheet with title, description, explicit close, Escape, focus trap/restoration, native inert background, body scroll lock, and independent scrolling
  - evidence detail adds the secondary chunk ID and authorized source record

### Test and environment support

- `tests/unit/deals.service.test.ts`
  - proves the four post-authorization workspace reads start concurrently
  - proves reinforcing-only Slack evidence does not fabricate a gap, warning, or action
- `tests/integration/deals-api.test.ts`
  - real authenticated HTTP list/workspace projection
  - strict ISO values and complete nine-section response
  - stable Slack label and secondary chunk ID
  - source-scoped list fields and restricted-source grants do not cross authorization boundaries
  - unauthorized source filtering and identical opaque hidden/nonexistent denial
- `tests/e2e/deals.spec.ts`
  - authorized list and workspace
  - all nine sections, Slack impact, citations, semantic desktop/mobile records
  - desktop complementary region sizing/focus/history
  - mobile/constrained modal behavior, focus, inert, scroll lock, Escape, deep link, Back, no overflow, and axe
- `tests/e2e/no-leak-ui.spec.ts`
  - list, direct UI, and API opacity for unauthorized OPP-1003 access
- `playwright.config.ts`
  - respects an injected disposable `DATABASE_URL` while preserving the existing local default


### Review regressions

The post-implementation review identified four boundary cases, each converted to a failing regression before correction:

- Salesforce-derived list fields are joined only for accounts with an applicable Salesforce grant, including restricted-read eligibility.
- Restricted workspaces exclude source grants that do not independently permit restricted evidence.
- Reinforcing Slack updates remain valid alignment evidence but no longer synthesize a missing-information gap, warning, or action.
- Closing a citation opened from the deal workspace consumes its pushed history entry, so the next Back action returns to the deal list; direct deep-link and session-teardown cleanup still use replacement navigation.

## GREEN evidence

### Focused API and concurrency tests

```text
DATABASE_URL=… pnpm exec vitest run tests/unit/deals.service.test.ts tests/integration/deals-api.test.ts
Test Files 2 passed (2)
Tests 6 passed (6)
```

### Task 12 browser suite

```text
DATABASE_URL=… pnpm exec playwright test tests/e2e/deals.spec.ts tests/e2e/no-leak-ui.spec.ts --workers=1
Running 6 tests using 1 worker
6 passed (8.6s)
```

### Related Task 11 login flow

```text
DATABASE_URL=… pnpm exec playwright test tests/e2e/login.spec.ts --workers=1
Running 5 tests using 1 worker
5 passed (6.5s)
```

### Type safety

```text
pnpm --filter @slacato/contracts build
passed

pnpm typecheck
passed with no diagnostics
```

No formatter, linter, project-wide build, or project-wide test suite was run, per the task constraints.

## Actual Chromium inspection

The real Vite/Nest/PostgreSQL surface was driven in Chromium after focused automation.

- 1440×900 authorized workspace:
  - document `scrollWidth === clientWidth === 1440`
  - all nine exact section headings were present
  - the default main column measured 1136px
  - status, identity, four metrics, source-backed copy, semantic tables, and restrained Cato tokens remained readable
- 1440×900 desktop evidence:
  - selected Slack citation deep-linked to `?evidence=slack%3ASLK-1001-02%3A0`
  - complementary region measured 403.1875px wide and 788px high
  - main column remained 708.8125px wide
  - evidence region used `overflow-y: auto`, received focus, and the document still had no horizontal overflow
  - visible detail included `source=slack/account_team_updates.tsv, update_id=SLK-1001-02` and secondary chunk ID `slack:SLK-1001-02:0`
- 390×844 mobile evidence:
  - modal measured exactly 390×844
  - document width remained 390px
  - body overflow was `hidden`, `#main-content` was inert, and focus entered `Close evidence detail`
  - the source record wrapped without horizontal overflow
- 390×844 mobile workspace:
  - full-width hierarchy, stacked metrics, bottom navigation, and complete mobile records remained legible
  - Escape restored focus to the originating Slack citation
- 390×844 unauthorized direct route:
  - `/deals/OPP-1003` resolved to `/forbidden`
  - the opaque permission-boundary surface contained no hidden account name, source locator, or evidence text
  - serialized HTML did not contain the restricted account name and document width remained 390px

## Decisions and known risks

- Canonical ingestion does not create a completed run or brief for the three demo opportunities. Task 12 therefore presents a truthful `source_backed` brief projection and reports `No run yet` instead of fabricating generated output. When a latest run exists, its persisted status and ISO update time are projected. Creating/running/approving briefs remains Task 13.
- A source-backed workspace can contain many authorized chunks. The Source Evidence section visibly offers a bounded representative set of 12 citation controls while the API retains the complete authorized evidence collection for real section citations and deep links.
- Sensitive pricing evidence remains absent for personas without `sensitivePricing`, even when other authorized conversation text contains the ordinary word “pricing.” Tests assert the source-type and locator boundary rather than censoring benign authorized prose.
- The desktop split decision is based on measured workspace width, not viewport width alone. A 1024px viewport correctly uses the modal because the Task 11 rail and content padding would otherwise shrink the main column below 640px.
