# Authorized retrieval baseline

SlaCato Part 1 uses PostgreSQL full-text search and exact pgvector cosine distance over the caller's authorized account/opportunity subset. Authorization and sensitive-pricing predicates are inside the candidate CTE, before lexical or semantic rank. There is deliberately no HNSW, IVFFlat, cross-encoder, or reranker in this baseline; the integration suite compares the selective query with an exact baseline and inspects `EXPLAIN` to prevent an accidental ANN path. Reranking remains a Part 2 experiment after baseline metrics are reviewed.

`EvidencePlan` is the stable execution recipe. It runs the user query plus fixed brief-section queries, applies distinct per-source limits, and fuses stable evidence IDs with RRF (`k = 60`). Reliability and recency adjustments are transparent and bounded to ±0.02. Exact authorized account, opportunity, and contact records are returned as cited evidence and persisted in the manifest; their counts remain separately visible in diagnostics. These structured grounding records use the context budget but do not displace the ranked top-k quality set.

Policy evidence is mandatory when an authorized policy row exists. Retrieval reserves one result slot and a bounded context slice for the highest-ranked authorized policy chunk, using the deterministic fixed-source row only when no policy chunk ranked. Diagnostics explicitly report `included`, `missing`, or `not_evaluated`, plus truncation and missing requested source types; a context limit therefore cannot silently erase policy.

Every run writes one immutable manifest. The run must already bind the requested opportunity and persona. The scope hash also binds the target account/opportunity, the query hash binds the complete stable plan/configuration, and `policy_hash` is the single canonical policy content hash (mixed policy hashes fail closed). Entries preserve content hash, locator, classification, source/sensitivity, ranks, fusion/final scores, adjustments, and the exact included character count. At-least-once replay first finds, reauthorizes, and validates the stored snapshot, so later unembedded rows or policy versions cannot invalidate an already committed run; changed request inputs still conflict. Citation resolution reauthorizes current content and manifest membership, with the same opaque denial for missing, stale, unauthorized, and out-of-manifest citations.

The deterministic TypeScript evaluation deduplicates IDs for precision@k and recall@k. Security-only denied/BOLA cases still call the real retriever and count leakage, but do not inflate the quality macro. Run it with:

```sh
pnpm tsx scripts/evaluate.ts retrieval
```
