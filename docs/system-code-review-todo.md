# Open engineering items

Working notes for the maintainers. Not a submission deliverable — the reviewer-facing documents
are `README.md`, `docs/technical-overview.html` (including its security-notes section), and
`docs/railway-deployment.md`.

- Add a delete-run action for finished runs (soft delete, preserving the run's trace and approval
  history so the audit record stays intact).
- Record per-run provider spend. Token usage is persisted per attempt; it is never converted to a
  currency cost, which the technical overview currently discloses as a known limitation.

## Done

- Wired the golden-retrieval regression eval (`scripts/evaluate.ts retrieval`, exposed as
  `pnpm eval:deterministic`) into CI as a "Run golden-retrieval regression eval" step (Task 15,
  Step 4). Running it end to end for the first time surfaced two schema-drift bugs in the harness's
  synthetic run insert (`runs.start_request_hash` is now `NOT NULL`, and `runs_one_active_opportunity_uq`
  rejects two concurrent active runs on the same opportunity, which the golden set's two
  `OPP-1003` cases triggered); both are fixed in `scripts/evaluate.ts`. With those fixed the harness
  now runs and gates correctly, but it currently reports `macroRecallAtK` of ~0.33 (below the 0.5
  gate) because of one golden case, `eclipse-discount-risk-routing`, which expects
  `slack:SLK-9009:0` and `policy:deal-desk-policy:OPP-1003:1` but the retriever currently returns
  Salesforce contacts plus `policy:deal-desk-policy:OPP-1003:3` instead. This looks like a real,
  reproducible retrieval-quality gap (confirmed deterministic across repeated runs), not a flake —
  it needs a follow-up look at `PostgresHybridEvidenceRetriever` or the golden fixture before this
  CI check will go green.
