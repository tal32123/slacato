# Spec compliance audit — Cato GTM AI Engineer Home Task

Audited 2026-08-30 against `Cato_GTM_AI_Engineer_Home_Task.docx` (verified identical, md5
`7cf268c9973c69f0aa4ebc50a11cc4c1`, to the copy in `~/Downloads`). Verdicts: **Implemented +
verified** (file:line + a passing test or direct evidence), **Present but unverified/dead**
(exists but not wired, or contradicted by tests), or **Missing**.

## 0. Environment note — read this before trusting any test run in this repo

`pnpm test` fails 15/457 tests **unless `DATABASE_URL` from the real `.env` is exported into the
shell first** (`postgresql://...@127.0.0.1:54329/slacato_openrouter`). `drizzle-kit` does not
auto-load `.env`; run without it and both `drizzle-kit migrate` and `vitest` silently fall back to
the `slacato` DB name baked into `drizzle.config.ts`, which is behind on migrations 0017/0019/0021
(`approval_authority_grants.source_commit` missing, `run_budgets.max_input_tokens` still
`NOT NULL`). Once the correct env is sourced and migrated: **456/456 tests pass, 1 skipped.** This
is an environment footgun, not a code defect — but it will burn a reviewer's first five minutes
unless the README (currently absent, see §9) says explicitly: `set -a; source .env; set +a` before
`pnpm db:migrate` / `pnpm test`.

## 1. Agents & orchestration (§4, §5)

- **≥3 specialized LLM-backed agents**: **Implemented + verified**. `ConversationAgent`
  (`packages/core/src/application/agents/conversation.ts`), `StakeholderAgent` (`stakeholder.ts`),
  `CommercialAgent` (`commercial.ts`) run as subagents; `StrategyAgent` (`strategy.ts`) fans them
  in. This maps onto the suggested design (Conversation Intelligence / Stakeholder Map /
  a commercial+policy specialist instead of a separate "Deal Context" agent, since deal/account
  data is loaded deterministically rather than through an LLM call — a defensible substitution,
  the spec explicitly allows a different design).
- **Typed contracts, tools, validation, failure modes**: **Implemented + verified**. Each agent
  takes an immutable `AgentContext` (`agents/contracts.ts:67`) exposing only evidence + a model
  gateway (no repository/tool/other-agent access), returns a schema-validated artifact
  (`domain/briefs/schema.ts`), and `validation.ts` (1,300+ lines) does per-claim grounding checks
  (`assessClaimSupport`, paraphrase/contradiction detection, `assertAgentContextBindings`).
- **Orchestration pattern**: durable workflow / outbox pattern — `apps/worker` +
  `packages/infrastructure/src/worker/deal-brief.processor.ts` +
  `PostgresWorkflowStore`/`OutboxDispatcher`/`ReconcilerLoop`. State is persisted to Postgres
  between steps (see §5). Not documented anywhere reviewer-facing (only inside
  `docs/superpowers/` planning notes, which read as internal scratch, not a deliverable).
- **Partial-failure handling**: **Implemented + verified** — `ReconcilerLoop` /
  `PostgresCommandReconciler` requeue abandoned work (`tests/integration/recovery.test.ts`), and
  `assertAgentContextBindings` fails a step closed rather than silently degrading if evidence
  scope narrows mid-run.

## 2. Brief output contract & citations (§4)

- **All 9 required sections**: **Implemented + verified** —
  `packages/core/src/domain/briefs/schema.ts:217` `dealBriefSchema` has exactly the 9 fields
  (`dealSnapshot`, `executiveSummary`, `buyerGoalsAndBusinessDrivers`, `stakeholderMap`,
  `negotiationState`, `recommendedNextActions`, `missingInformation`, `sourceEvidence`,
  `confidenceAndReviewWarnings`), `.strict()`.
- **Citation format**: **Implemented + verified** — `source=<file>, <id>=<value>` pattern is
  built and asserted in `tests/e2e/deals.spec.ts:70`
  (`source=slack/account_team_updates.tsv, update_id=SLK-...`).
- **Citation grounding is NOT cosmetic / NOT limited to code-pulled facts** — this was the user's
  stated worry and it does not hold up against the code: every one of the 9 sections carries a
  `claims: Claim[]` field, and every `Claim` carries `citations: Citation[]` with an `evidenceId`
  (`schema.ts:49`, `146-211`). This applies identically to LLM-*synthesized* prose
  (`executiveSummary.claims`, `negotiationState.claims`, `recommendedNextActions.actions[].claims`)
  and to deterministic fields (`dealSnapshot.claims`). `StrategyAgent`'s prompt
  (`agents/strategy.ts:21`) explicitly instructs: "Every factual claim must cite an authorized
  manifest record... make each narrative... exactly equal to one supporting claim statement
  instead of paraphrasing it." Post-generation, `validateDealBrief` / `assessClaimSupport`
  (`validation.ts:450`) reject claims whose statement isn't actually supported by the cited
  evidence text (paraphrase/contradiction detection), and
  `apps/api/.../deal-workspace.mapper.ts:157` refuses to render generated output at all if any
  citation points outside the authorized evidence set.
  - **UI**: `apps/web/src/features/briefs/deal-brief.tsx` renders all 9 sections through one
    `WorkspaceContent`/`CitationControls` component for *both* the deterministic source snapshot
    and the generated brief — there is no visible UX asymmetry between "code-pulled" and
    "LLM-synthesized" sections; both get the same citation chips.
  - **What actually doesn't exist**: any chat / free-text AI interaction surface. `grep -rli chat
    apps/web/src` returns nothing. The structured brief is the only AI-facing UI. If "show sources
    in the AI usage in general" meant *a conversational RAG surface*, that's accurate — it's
    absent — but it's not a spec requirement (§4's brief-section list is the deliverable); it's the
    feature already on your own list in `docs/system-code-review-todo.md` ("SHOULD WE ADD... A
    CHAT VIEW?"). Treat that as a **user-requested, not spec-required** follow-on, separate from
    this audit's gap list.

## 3. RAG / retrieval layer (§7, bonus §10)

- **Real indexing + retrieval**: **Implemented + verified** — pgvector cosine search with
  permission filtering baked into the SQL itself, not post-filtered:
  `packages/infrastructure/src/db/repositories/evidence-repository.ts:25-46`
  (`1 - (evidence.embedding <=> ...)`, `and evidence.opportunity_id is not distinct from ...`).
- **Metadata filtering**: **Implemented + verified** — `buildEvidencePlan`
  (`packages/core/src/application/evidence/retriever.ts:18`) issues per-section queries scoped to
  specific `sourceTypes`, with `sourceLimits` and a mandatory `policy` reservation.
- **Hybrid search (bonus)**: **Implemented + verified** — real RRF,
  `packages/core/src/application/evidence/rrf.ts` (`reciprocalRankFusion`, k=60), covered by
  `tests/unit/rrf.test.ts`.
- **Recency weighting (bonus)**: **Implemented + verified** —
  `applyEvidenceAdjustments` (`retriever.ts:90`) decays non-policy evidence by age, capped ±0.02.
- **Source reliability scoring (bonus)**: **Implemented + verified** — same function,
  `RELIABILITY_ADJUSTMENTS` keyed by reliability class.
- **Citation validation (bonus, also required by §4)**: **Implemented + verified** — see §2 above
  (`assessClaimSupport`, `canonicalEvidenceIsAuthorized`).
- **HNSW**: `docs/hnsw-retrieval-architecture.md` describes an *aspirational, gated* future state
  ("Eligible promoted security domains may activate HNSW only after recall, leakage, underfill,
  latency, and operational gates pass"). Current operative path is exact authorized-subset cosine
  search — correctly labeled in the doc as the present oracle/fallback, not a discrepancy, just
  don't present the HNSW doc as describing shipped behavior in the interview.

## 4. Permissions, guardrails, approvals (§4, §7)

- **Permission gate before retrieval**: **Implemented + verified** — filtering is in the query
  itself (§3), and `deal-brief-access.ts` / auth guard reject before any evidence read.
- **Pricing sensitivity is multi-signal, not single-column**: **Implemented + verified** for the
  deterministic approval-trigger layer — `decideApprovalRequirement`
  (`packages/core/src/domain/briefs/policy.ts:221`) combines `discountPercent`,
  `renewalUpliftPercent`, four independent legal-language flags (liability cap, data retention,
  restricted research, customer-specific security), `overallConfidence`, and
  `conflictingEvidence`/`missingMaterialEvidence` into distinct approval-requirement entries per
  `deal_desk_policy.md` rules 1-7 — never a single boolean/column gate. One caveat: this function
  consumes already-derived numbers (`input.discountPercent`, etc.); the upstream step that reads
  raw `pricing_notes.tsv` + opportunity restriction fields + the retrieved policy text and derives
  those numbers is the LLM-driven `CommercialAgent`, not a second deterministic parser — so the
  *extraction* is evidence-gated and validated (§2) but LLM-mediated, while the *approval-trigger
  decision* on top of it is fully deterministic and verified.
- **No-leak on denial**: **Implemented + verified** — `opaqueCitationDenial()`
  (`evidence/citations.ts`) plus `tests/e2e/no-leak-ui.spec.ts` (unauthorized persona gets opaque
  denial with no names/counts/source metadata/snippets/locators, can't discover the deal via list
  or direct nav).
- **Human-in-the-loop approval, server-enforced**: **Implemented + verified** —
  `DecideApproval.execute` (`approvals/decide-approval.ts`) enforces authority membership,
  per-category quorum (e.g., discount quorum requires *distinct* deal_desk + sales_leader actors,
  `decide-approval.ts:215-234`), idempotency, optimistic-concurrency version checks, and blocks
  edits from silently changing an already-validated citation binding
  (`decide-approval.ts:256-267`). Finalization is enqueued only after quorum — a rejected/
  unapproved brief cannot reach the finalized/customer-facing path.
- **Prompt-injection defense (bonus)**: **Partially implemented** — one real, passing test exists:
  `tests/contract/agents.test.ts:194` ("cannot let an evidence record close the fixed inert-data
  delimiter") proves evidence text can't escape the untrusted-data block to hijack instructions.
  This is **not documented** anywhere reviewer-facing and is a single injection vector (delimiter
  escape), not the broader "documented prompt-injection test cases and defenses" the bonus asks
  for.
- **Golden-label eval (bonus)**: **Present, needs a documented entry point** —
  `scripts/evaluate.ts` implements a golden-case schema (`relevantEvidenceIds`, `expectedDenied`)
  and retrieval-quality/leakage scoring, but nothing in `package.json` scripts or (absent) README
  tells a reviewer to run it.

## 5. Observability, state, cost (§4, §7)

- **Traces**: **Implemented + verified** — `TraceStore`/`TraceCompletenessError`
  (`application/events/run-events.ts`), append-only spans, `assertTraceComplete`.
- **State persistence across runs**: **Implemented + verified** — Postgres-backed
  (`PostgresWorkflowStore`, `drizzle/*.sql`), not in-memory; survives process restart per
  `tests/integration/recovery.test.ts`.
- **Cost/token budgeting**: **Implemented + verified** — typed `RunBudgetLimits`/
  `SharedRunBudget` (`application/model/contracts.ts`) enforced through the shared retry/budget
  controller (`model/retry.ts`), persisted per-run (`run_budgets` table).

## 6. Slack data-generation subtask (§3)

- 3 updates/opportunity (≥2 required), synthetic, role-based authors, no PII: **Implemented +
  verified** (`fixtures/cato/slack/account_team_updates.tsv`, rows SLK-9001..9009).
- reinforces/adds-context/ambiguity categorization: **Implemented + verified**, but only in
  `fixtures/cato/slack/generation.json`'s `rowContextKinds`/`coverage` — **not** a column in the
  ingestible TSV itself. Fine per the letter of the spec (categorization isn't required to be
  ingested), but worth a one-line callout in the docs so a reviewer doesn't go looking for it in
  the TSV.
- `slack` permissioned via `access_permissions.tsv`, `source_access_level` present: **Implemented
  + verified**.
- Live LLM provenance: **Implemented + verified, and `docs/compatibility.md` is now stale** — that
  doc still says every provenance field is "Pending credentialed probe" and warns "the repository
  does not yet contain an automated live-artifact verifier." `generation.json` now shows
  `provider: openrouter`, `model: google/gemini-3.5-flash-lite`, nonzero token usage, hashes,
  `generatedAt: 2026-08-29`. Update or delete the stale warning before submission — as written it
  actively undersells work that's already done.

## 7. Required demo scenarios (§8)

All four have real e2e coverage:
1. Brief for OPP-1001/1002 as owner — `tests/e2e/deals.spec.ts`.
2. OPP-1003 + approval routing — `tests/e2e/approval.spec.ts` (quorum, edit/approve, reject).
3. Unauthorized OPP-1003 access, no leak — `tests/e2e/no-leak-ui.spec.ts`.
4. Cited generated Slack update — **covered**: `tests/e2e/deals.spec.ts` asserts on citation id
   `SLK-9002` / evidence key `slack:SLK-9002:0`. This standard-access OPP-1001 update is visible to
   Maya Levin and drives the brief's account-team update impact.

## 8. Bonus scorecard (§10)

| Item | Status |
|---|---|
| Hybrid search | ✅ Implemented + verified |
| Metadata filtering | ✅ Implemented + verified |
| Recency weighting | ✅ Implemented + verified |
| Source reliability scoring | ✅ Implemented + verified |
| Citation validation | ✅ Implemented + verified |
| Cost-aware routing / token budgeting | ✅ Budgeting yes; provider-choice-by-cost routing not found — only single configured provider/model per env |
| Prompt-injection test cases + defenses | ⚠️ One real test, undocumented, single vector |
| Golden-label synthetic eval + regression tests | ⚠️ Harness exists (`scripts/evaluate.ts`), not wired into a documented/discoverable command |

## 9. Deliverables (§9) — the real gap

- **A. Runnable prototype**: present (api/web/worker monorepo).
- **B. Architecture diagrams**: **Missing**. No `.png`/`.svg`/`.drawio` outside
  `node_modules`/`dist`, no mermaid blocks anywhere in `docs/`.
- **C. README, technical overview, security notes**: **Missing**. No `README*`, `SECURITY*`,
  `ARCHITECTURE*`, or `OVERVIEW*` at repo root, in `docs/`, or under any `apps/*`. `docs/` only
  holds internal engineering notes (`compatibility.md`, `retrieval.md`,
  `hnsw-retrieval-architecture.md`, `deferred-production-enhancements.md`,
  `system-code-review-todo.md`) plus `docs/superpowers/` planning artifacts — none reviewer-facing.
- **D. Sample run artifacts**: **Missing** as a discrete, checked-in deliverable. No `samples/`,
  `artifacts/`, or `examples/` directory with a generated brief, approval-flow output, or trace/log
  example a reviewer can read without standing up the stack themselves.
- **E. Interview presentation**: out of scope for a code audit.

### Priority order (cheapest fix × most damaging to skip, first)

1. **Write README + technical overview + security notes.** Everything technical this audit found
   (multi-agent design, durable workflow, RAG w/ RRF+recency+reliability, permission-before-
   retrieval, quorum approvals, traces, budgets) is real and defensible — right now none of it is
   visible to a reviewer without reading source. This is close to pure transcription work of what
   already exists; it is the single highest-leverage thing left to do. Include the `.env`
   footgun from §0 explicitly.
2. **Add architecture diagrams** (mermaid in a markdown file is spec-compliant — "diagram format
   is not important"): logical view (agents/orchestration/RAG/approvals/observability) and
   deployment view (services/storage/secrets/model gateway/monitoring).
3. **Keep the cited Slack-update E2E assertion aligned with the reviewed live fixture** — it now
   uses the authorized OPP-1001 update `SLK-9002` and proves demo scenario 4.
4. **Populate a `samples/` directory** with one generated brief, one approval-flow trace, and one
   run-trace export, produced by a real (openrouter) run — you already have the live pipeline
   (`AI_PROVIDER=openrouter` is configured in `.env`); this is a run-and-copy task, not new code.
5. **Refresh `docs/compatibility.md`** — its "pending credentialed probe" language is now false
   and undersells finished work.
6. Lower priority: document the one prompt-injection test as a named defense in the security
   notes; add a `package.json` script + README line pointing at `scripts/evaluate.ts`.
