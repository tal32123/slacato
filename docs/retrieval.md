# Adaptive authorized retrieval

SlaCato Part 1 uses PostgreSQL full-text search plus adaptive pgvector semantic search. The retrieval module recomputes authorization before search, uses exact cosine for small or highly selective authorized domains, and uses HNSW only for large, stable, promoted security domains that pass activation gates. It never uses one global shared HNSW graph.

HNSW is an internal candidate adapter: iterative scans and bounded overfetch find candidate IDs, the IDs are rejoined through the complete current authorization relation, and results are reranked with full-precision exact cosine before RRF, recency/reliability adjustments, and manifest commit. Exact search remains the oracle, bounded fallback, and kill-switch target. Mandatory policy and exact CRM grounding do not depend on ANN.

The full physical design, filtering behavior, rollout, and measurable gates are in [Adaptive Authorized HNSW Retrieval](hnsw-retrieval-architecture.md).

`EvidencePlan` is the stable execution recipe. It runs the user query plus fixed brief-section queries, applies distinct per-source limits, and fuses stable evidence IDs with RRF (`k = 60`). Reliability and recency adjustments are transparent and bounded to ±0.02. Exact authorized account, opportunity, and contact records are returned as cited evidence and persisted in the manifest; their counts remain separately visible in diagnostics. These structured grounding records use the context budget but do not displace the ranked top-k quality set. Packing reserves a meaningful minimum eight-character excerpt for every ranked and exact grounding item; a budget too small for that invariant fails explicitly instead of silently dropping evidence.

Policy evidence is mandatory when an authorized policy row exists. Retrieval reserves one result slot and a bounded context slice for the highest-ranked authorized policy chunk, using the deterministic fixed-source row only when no policy chunk ranked. Diagnostics explicitly report `included`, `missing`, or `not_evaluated`, plus truncation and missing requested source types; a context limit therefore cannot silently erase policy.

Every run writes one immutable manifest. The run must already bind the requested opportunity and persona. The scope hash also binds the target account/opportunity, the query hash binds the complete stable plan/configuration, and `policy_hash` is the single canonical policy content hash (mixed policy hashes fail closed). Entries preserve content hash, locator, classification, source/sensitivity, ranks, fusion/final scores, adjustments, and the exact included character count. At-least-once insert accepts either deterministic manifest-ID or run-ID contention, then reauthorizes and validates the immutable winner; later unembedded rows or policy versions cannot invalidate an already committed run, while changed request inputs still conflict. Citation resolution reauthorizes current content and manifest membership, with the same opaque denial for missing, stale, unauthorized, and out-of-manifest citations.

The deterministic TypeScript evaluation deduplicates IDs for precision@k and recall@k. Security-only denied/BOLA cases still call the real retriever and count leakage, but do not inflate the quality macro. Run it with:

```sh
pnpm tsx scripts/evaluate.ts retrieval
```
