# Open engineering items

Working notes for the maintainers. Not a submission deliverable — the reviewer-facing documents
are `README.md`, `docs/technical-overview.html` (including its security-notes section), and
`docs/railway-deployment.md`.

- Add a delete-run action for finished runs (soft delete, preserving the run's trace and approval
  history so the audit record stays intact).
- Record per-run provider spend. Token usage is persisted per attempt; it is never converted to a
  currency cost, which the technical overview currently discloses as a known limitation.

- Give hybrid retrieval its own Salesforce candidate window. `CANONICAL_CRM_RECORD_LIMIT = 7`
  (`packages/core/src/application/evidence/retriever.ts`) serves two different jobs: the deliberate
  "always show every CRM record" guarantee in `searchExactCrmEvidence`, and the per-source-type
  candidate window that lexical/semantic search use to admit only their top-N *relevant* rows before
  RRF fusion. Each opportunity has at most seven Salesforce rows, so as a window it is a no-op -
  every Salesforce record enters every search, while slack and gong_summary are capped at 2. That
  structural pass-through is why Salesforce contacts crowd the golden-retrieval results. Splitting
  the constant needs a chosen number for the search window, which is a product decision, so it is
  left here rather than guessed at.
- Golden-retrieval `macroRecallAtK` now sits at exactly 0.5, the gate boundary (`< 0.5` fails). It
  passes, but with no headroom: any small ranking regression turns CI red. The remaining recall loss
  is the Salesforce crowding above, plus the mock embedding gateway used in CI - the semantic half of
  hybrid search is not a meaningful signal under mock embeddings, so this metric mainly exercises the
  lexical channel today.
- `stakeholderIdentitySupported` (`packages/core/src/application/agents/validation.ts`) documents that
  a stakeholder survives on "a title **or** organization stated by the same record that names them",
  but builds `profile = [title, organization]` and requires *both*. Currently unreachable, because
  claims are pruned against their evidence before the identity tuple is evaluated, so it is a latent
  contract mismatch rather than a live bug - it becomes reachable the moment claim pruning loosens.

## Done

- Wired the golden-retrieval regression eval (`scripts/evaluate.ts retrieval`, exposed as
  `pnpm eval:deterministic`) into CI as a "Run golden-retrieval regression eval" step (Task 15,
  Step 4). Running it end to end for the first time surfaced two schema-drift bugs in the harness's
  synthetic run insert (`runs.start_request_hash` is now `NOT NULL`, and `runs_one_active_opportunity_uq`
  rejects two concurrent active runs on the same opportunity, which the golden set's two
  `OPP-1003` cases triggered); both are fixed in `scripts/evaluate.ts`. With those fixed the harness
  now runs and gates correctly. Its first real run failed at `macroRecallAtK` ~0.33, which turned out
  to be a genuine retrieval defect rather than a stale fixture: the lexical channel gated on a
  conjunctive `websearch_to_tsquery`, matching zero rows in the whole corpus for the golden query.
  Fixed by scoring partial lexical matches; the gate now passes at `macroRecallAtK` 0.5,
  `permissionLeakage` 0. Recall sits exactly on the boundary — see the open item above.
