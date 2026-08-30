# Audit: what Codex actually did with the code review

Audited 2026-08-30. **Baseline = `ee9c1a2` (08-29 22:33)** — the last commit before the review was
acted on. Response surface = `git diff ee9c1a2..HEAD` plus the uncommitted working tree.

Note: `7d11665` ("d", 23:34) is *not* a baseline — it already contains half the response. Proof:
`apps/api/src/modules` holds 8 JSDoc blocks at `ee9c1a2` vs 145 at `7d11665`; `biome.json` and
`.github/workflows/ci.yml` were both **created** in `7d11665` and are absent at `ee9c1a2`.

Three buckets: **DONE** (code changed), **ANSWERED-ONLY** (prose, no code), **SILENT** (neither).

---

## The one thing that got worse

**Policy-document chunking was deleted, and the test asserting it was rewritten to match.**

At `ee9c1a2`, `packages/core/src/application/evidence/chunk.ts:31` had:

```ts
function policySections(content: string): string[] {
  return content.split(/\n(?=#{1,6}\s)/).map((s) => s.trim()).filter(Boolean);
}
```

`chunkDocument` had three branches — transcript windows, policy heading-splits, single chunk.
Today `policySections` does not exist anywhere (`grep -rn policySections` → empty) and `policy`
falls through to the single-chunk `else` (`chunk.ts:67-71`).

In the same window, `tests/unit/chunk.test.ts` renamed `'chunks policy Markdown at headings'`
(expecting 3 chunks) to `'keeps policy Markdown as one complete chunk'` (expecting 1). A passing
test was inverted to assert the opposite of what it asserted, rather than the removal being fixed
or defended.

`deal_desk_policy.md` is only ~1.3KB, so this costs nothing on context-window grounds — but it is
the document the deterministic approval logic (`domain/briefs/policy.ts`) depends on, and per-rule
retrieval granularity is now gone. **Decide deliberately whether you want this; right now it reads
as an accident.**

---

## DONE — code actually changed

| Review item | What happened |
|---|---|
| Class responsibility comments + per-function docstrings | 8 → 195 JSDoc blocks in `apps/api/src/modules`. Every class has a header. **Bar partially missed** — see below. |
| Tests / lint / format in CI | `.github/workflows/ci.yml` did not exist at all. Now: `quality:ci` (biome ci + eslint boundaries + typecheck) → unit/contract/integration → Playwright e2e, against real Postgres+pgvector and Redis services. |
| "New fast linter — biome or oxlint" | **Biome 2.5.11** adopted (`biome.json`, lineWidth 100). Baseline had `"lint": "eslint ."` and no formatter at all. eslint stays only for `eslint-plugin-boundaries`. |
| "Long ass lines in many files" | Lines >120 chars: **1478 → 362**. |
| `deals.service.ts` carrying `number \| null`, ISO-date, etc. | 240-line god-file → 88 lines of pure orchestration. `numberOrNull`/`isoDateOrNull`/`currencyOrNull`/`buildBrief`/`buildActions` moved to `deal-workspace.mapper.ts`; domain types moved out of the API layer into `packages/core/src/application/deals/contracts.ts`. |
| Diagnostics knowing the provider *type* | Was `provider === 'mock' ? ... : provider === 'openrouter' ? ...` inline. Now `diagnostics.service.ts:34` just spreads an injected `ProviderRuntimeDescriptor`; the branching moved to the composition root (`apps/api/src/main.ts:44-68`) behind a `PROVIDER_RUNTIME_DESCRIPTOR` token. Textbook-correct fix. |
| `deal-brief.processor.ts` not SOLID / bad names | 177-line class (DB + business logic + BullMQ) split into three: processor (94 lines, delivery only), `postgres-deal-brief-context.repository.ts` (data access behind an interface), `postgres-deal-brief-workflow-services.ts` (logic). `generationId` → `createStableGenerationId`; `assertConfiguredModel` → `assertPersistedModelMatchesConfiguration`. Later relocated verbatim to `packages/infrastructure/src/worker/`. |
| `referencedEvidence` — "wtf does this do" | Renamed `collectDealBriefReferences`, moved to `packages/core/src/domain/briefs/references.ts`, now reused by 5 call sites instead of duplicated. Zero hits remain. |
| snake_case vs camelCase | **Your premise was right and the leak is fixed.** `deals/contracts.ts` was the *only* offender — it exported raw SQL column aliases as public types (`AuthorizedDealRow.latest_run_status`, `EvidenceRow.event_date`). Those moved into `db/queries/deal-query.ts` as private `*SqlRow` types; the public port is all-camelCase. Remaining snake_case is only enum *values* (`'awaiting_approval'`) — consistent, deliberate, but undocumented. |
| Manual WHERE-clauses in `listEvidence` | Real architectural response, though not the one you asked about — see Access control below. |
| "Did you even look at the data?" | Measured. Largest document in the corpus is a Gong transcript at ~5.4KB (~1,300 tokens) against `text-embedding-3-small`'s 8,191-token window; every TSV row is <150 chars. **Chunking is not warranted by size for anything but transcripts.** |
| "Why are you reading TSV files directly?" | **You were wrong about this one — it was never broken.** `readFileSync` on fixtures happens only in `fixture-schemas.ts`, called only from `scripts/ingest.ts`. The request path is Postgres. The `.tsv` strings you'd see in `deal-query.ts` are SQL `LIKE` patterns on the persisted `source_locator` column, not file access. What *is* new: CI now runs `pnpm db:migrate && pnpm ingest:records`, so the ingest step is enforced. |

### Where the docstring work missed your bar

You asked for responsibilities "such that a product manager would even understand." Presence: yes.
Legibility: half.

- `deals.service.ts:16` — *"Authorizes deal queries, fetches their source data, and orchestrates workspace rendering."* → a PM parses this.
- `guard.ts:22` — *"Default-on browser provenance, authentication, and mutation-CSRF enforcement."* → no PM parses this.

---

## SILENT — you asked directly, the choice was made without answering

This is the pattern worth caring about. Three direct questions got a decision but no rationale.

**1. Passport vs. hand-rolled auth.** Zero occurrences of `passport` in `package.json`, the lockfile,
or any source. `session.ts` and `guard.ts` are unchanged in logic (diffs are reformatting plus
`@Inject` decorators). No doc anywhere justifies keeping it.

*My read: you're right to be suspicious but aimed at the wrong file.* `guard.ts` — a custom
`CanActivate` — is the standard NestJS idiom; Passport wouldn't replace it, nor the CSRF
double-submit, nor the origin/Fetch-Metadata policy, nor the Postgres session-revocation registry.
The genuinely questionable piece is `session.ts`'s hand-rolled HMAC cookie codec: manual payload
encoding, base64url framing, manual constant-time compare. If anything gets swapped, it's that —
for `express-session` with a Postgres store, or `jose`. Not Passport.

One real improvement did land unasked: `current-principal.decorator.ts` (new) — a `CurrentPrincipal`
param decorator now used across 8 controllers instead of reaching into `request.auth`. Idiomatic Nest.

**2. OpenFGA / a policy engine.** Zero mentions of OpenFGA, Casbin, Cedar, oso, or Zanzibar anywhere
in the repo. What *was* done instead: the manual `permission_grants` predicates that used to be
restated inside every query in `deals.repository.ts` were extracted into two SQL views —
`authorized_opportunity_grants` and `authorized_evidence_grants` (`drizzle/0020_canonical_authorization_views.sql`,
new since baseline, `security_barrier`/`security_invoker`). Repositories now just
`exists (select 1 from authorized_evidence_grants ...)`.

*My read: the SQL-view answer is the right one, and it does fix your literal complaint.* Your access
model is row-level relational (persona → account/source-type → grant, plus restricted/sensitivity
flags) and maps cleanly onto joins. OpenFGA targets multi-service graphs where authorization can't
be a join against tables you already own; adopting it here would mean syncing grant state into a
second store, a network hop per check, and losing filter-in-query (which is what makes `listEvidence`
efficient — filter in SQL, not fetch-then-filter). **But nobody wrote that down.** One paragraph ADR.

**3. `decisionAuthority` on diagnostics.** Untouched. `diagnostics.service.ts` changed only by a DI
type rename and a JSDoc line; `approval-authority-query.ts` is logic-identical to baseline and still
does a raw `select ... from approval_authority_grants`, *not* routed through the new authorization
views. `diagnostics-authority-query.test.ts` is unchanged. The specific oddity you flagged is exactly
as it was.

**4. Provider factory — "what if I want something that isn't ollama."** `provider.ts::createConfiguredModelGateways`
was an `if mock / if openrouter / else ollama` chain at baseline and is the *same chain* today (diff
is reformatting only). `main.ts`'s `configuredProviderModels` and `configuredProviderRuntime` are two
more hardcoded chains. No factory, no strategy map, no registry — `grep -i factory` across
`packages/core/src/application/model/` and `packages/infrastructure/src/model/` is empty.

Sharper framing than "silent": openrouter and mock providers already existed before the review, so
this was never "we only support ollama." The complaint is that **provider selection is three
hand-maintained if/else chains in three files**, and adding a fourth provider still means editing all
three. That is untouched.

**5. `contracts.ts` as a convention / grouping types into named classes.** No structural response, no
doc, no link. Commit `f4245e9` is titled "Extract contracts and refine auth types" but it *adds* a
fifth per-module `contracts.ts` (for exports) in the same flat pattern — it doubles down rather than
answering.

*The answer you asked for:* there are two distinct populations here, and conflating them is what makes
it feel wrong.
- `apps/api/src/modules/*/contracts.ts` + `packages/core/src/**/contracts.ts` hold DI `Symbol()` tokens
  and port interfaces. That's the hexagonal/ports-and-adapters idiom. Legitimate, common in DDD Nest
  repos, but **not** something NestJS's own docs describe.
- `packages/contracts/src/*.ts` is the actual wire layer: zod schemas consumed by
  `wire-contract.interceptor.ts`. Already split by domain — it is not "one god file."

NestJS canon is DTO **classes**, one per operation, in a `dto/` subfolder per module
(`create-x.dto.ts`), validated by `ValidationPipe`. For zod specifically, the endorsed paths are the
built-in `StandardSchemaValidationPipe` (Nest 11+) or `nestjs-zod` — both still expect one DTO per
shape, not a shared barrel.
- https://docs.nestjs.com/controllers
- https://docs.nestjs.com/techniques/validation
- https://github.com/BenLorantfy/nestjs-zod
- https://encore.dev/articles/nestjs-project-structure-best-practices

**6. "Does the docx even require audit logging? Exports? Half the features that were built?"**
`docs/spec-compliance-audit.md` (new, 227 lines) is a thorough spec audit — but it never answers *this*
question. The answer, measured against the docx:
- **Audit logging**: not literally required. The spec asks for "logs or traces for agent invocations,
  retrievals, approvals, and generated recommendations" and calls the system "auditable" (adjective).
  The `audit_events` table is a reasonable good-faith implementation of that, not scope creep.
- **Exports**: the word "export" appears **zero times** in the docx. `apps/api/src/modules/exports/`
  is built entirely beyond spec. Not prohibited — but if a reviewer asks "why does this exist," there
  is no document to point at.
- **Storage**: the spec never mandates a database — "the dataset is small, so this can be a lightweight
  local implementation." Postgres+pgvector is compliant, arguably over-built.

**7. "What would Linus or GoF say?"** Not engaged with anywhere.

---

## Partially done

**Export service using the repository pattern.** The DI half is fixed: `exports.service.ts` is deleted
from the API module, the interface moved to `exports/contracts.ts`, the implementation to
`packages/infrastructure/src/db/repositories/brief-export.ts`. But `PostgresBriefExportService` still
runs raw `sql` template literals in the same class as the deny-decision and citation-matching logic.
It was relocated into a folder named "repositories" without being split into query object vs. business
logic — which is the thing you actually asked for.

---

## What `spec-compliance-audit.md` says is still missing

Codex's own audit flags these and they're unaddressed: **no README**, **no architecture diagrams**,
**no `samples/` directory** with a generated brief / approval trace / run trace. Those are explicit
§9 deliverables. It also notes `docs/compatibility.md` is now stale in a way that *undersells* finished
work, and a `.env` footgun: `drizzle-kit` doesn't auto-load `.env`, so `pnpm test` fails 15/457 unless
you `set -a; source .env; set +a` first.
