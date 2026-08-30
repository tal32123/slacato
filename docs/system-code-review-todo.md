# Open engineering items

Working notes for the maintainers. Not a submission deliverable — the reviewer-facing documents
are `README.md`, `docs/technical-overview.html` (including its security-notes section), and
`docs/railway-deployment.md`.

- Add a delete-run action for finished runs (soft delete, preserving the run's trace and approval
  history so the audit record stays intact).
- Wire the golden-retrieval regression eval (`scripts/evaluate.ts retrieval`) into CI. The harness
  already gates on `permissionLeakage !== 0 || macroRecallAtK < 0.5`; only the CI step is missing.
  Planned as Task 15, Step 4 of the implementation plan.
- Record per-run provider spend. Token usage is persisted per attempt; it is never converted to a
  currency cost, which the technical overview currently discloses as a known limitation.
