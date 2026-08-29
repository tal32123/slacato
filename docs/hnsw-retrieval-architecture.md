# Adaptive Authorized HNSW Retrieval

## Decision

SlaCato will implement HNSW as a real semantic-candidate adapter, while preserving exact cosine as the oracle and bounded fallback.

It will not use one global HNSW graph. Aggregate corpus size is not the deciding factor because each run targets one opportunity/account and a selective permission scope. HNSW is selected only for large, stable security domains where it passes recall, latency, and leakage gates; small or highly selective authorized subsets continue to use exact cosine.

This decision was reviewed through three independent architecture passes:

- A minimal-interface design recommended a private HNSW candidate adapter over account-hash partitions and static access lanes.
- A production-scale design recommended exact-by-default with large ACL-equivalent domains promoted to dedicated HNSW relations.
- A security/recall review rejected shared global HNSW and required final PostgreSQL reauthorization, exact reranking, exact fallback, and explicit noninterference/recall tests.

The selected design combines the strongest parts: a deep retrieval module, a rebuildable profile-specific search projection, adaptive exact/HNSW routing, dedicated promoted security domains, exact reranking, and immutable manifest semantics.

## Deep module and interface

Callers express retrieval intent. They do not supply an `AccessScope` or HNSW settings.

```ts
export type EvidenceSearchCommand = Readonly<{
  runId: string;
  query: string;
  limit: number;
  maxContextCharacters?: number;
}>;

export interface EvidenceAccess {
  retrieve(command: EvidenceSearchCommand): Promise<RetrievalResult>;
  resolveCitation(request: CitationResolutionRequest): Promise<AuthorizedCitation>;
}
```

The implementation reloads the run, requester, opportunity/account, current grants, policy, active embedding profile, and search-strategy metadata. Exact and HNSW candidate sources are internal adapters behind this seam.

## Non-negotiable invariants

- Authorization is recomputed from persisted state before query embedding or any lexical/vector search.
- Denied or empty scopes never probe an ANN relation and reveal no hidden corpus metadata.
- Mandatory policy and exact CRM grounding use deterministic authorized paths independent of HNSW.
- HNSW returns candidate IDs only. Candidates are rejoined to the complete authorized PostgreSQL relation before content, locators, scores, or counts can be projected.
- Candidate order is reranked with exact full-precision cosine before source quotas, RRF, recency, and reliability adjustments.
- Manifest commit rechecks authorization, content hashes, embedding profile, policy lineage, and index generation in one transaction.
- Citation resolution reauthorizes current content and immutable manifest membership.
- The manifest records the selected adapter, index generation, HNSW settings hash, candidate count, exact-rerank version, fallback mode, and embedding profile.
- A strategy may fail closed or fall back to exact search; it may never broaden scope, remove sensitivity predicates, omit mandatory policy, or silently return lexical-only retrieval.

## Physical search projection

`evidence_versions` and run manifests remain immutable and authoritative. HNSW uses a rebuildable projection so profile changes and index generations do not rewrite source evidence or old manifests.

```text
evidence_versions                 immutable content and provenance
embedding_profiles               provider/model/dimension/version lifecycle
security_domains                 ACL fingerprint, lane, row count, strategy
security_domain_members          permitted principals and validity
search_index_generations         build, shadow, active, retiring metadata
evidence_search_<profile>        fixed-dimension full vector + ANN projection
promoted_<opaque-domain-slot>     dedicated large-domain HNSW relation
```

Each active profile gets a fixed-dimensional projection only after the credentialed embedding probe establishes dimension and normalization. The projection keeps a full-precision `vector(D)` for exact reranking; an HNSW relation may use `halfvec(D)` when measurement justifies the memory/recall tradeoff.

A security domain groups rows with one stable authorization fingerprint and access lane. Restricted-account and sensitive-pricing rows never share the standard domain. Domains are promoted only when authorized cardinality and sustained traffic justify ANN—for example, at least 100,000 active chunks. The threshold is configuration backed by measured plans, not a product setting.

## Query execution

1. Begin a bounded transaction and bind the persisted run/requester/opportunity.
2. Recompute grants and resolve authorized security domains and active embedding profile.
3. Replay an existing immutable manifest if one already exists.
4. Fetch mandatory policy and exact CRM grounding independently.
5. Run authorized PostgreSQL FTS.
6. Route semantic search per domain:
   - exact cosine for small/selective domains;
   - HNSW for promoted domains.
7. For HNSW, use pgvector iterative scan, bounded overfetch, and a materialized candidate relation.
8. Rejoin candidates through full authorization and rerank with exact cosine.
9. Apply source quotas, RRF (`k = 60`), bounded recency/reliability adjustments, and context packing.
10. Reauthorize and atomically persist the immutable manifest; return only committed entries.

Representative HNSW settings begin conservatively and are tuned by domain:

```sql
SET LOCAL hnsw.iterative_scan = 'relaxed_order';
SET LOCAL hnsw.ef_search = 160;
SET LOCAL hnsw.max_scan_tuples = 40000;
SET LOCAL hnsw.scan_mem_multiplier = 2;
```

The inner query uses `ORDER BY ann_embedding <=> query LIMIT candidate_k`; the outer materialized query reranks by full-precision exact distance and stable ID. Overfetch repairs ordering but cannot recover a candidate the graph never visited, which is why recall shadowing and exact fallback are required.

## Filtering behavior and security

PostgreSQL `WHERE` predicates still prevent unauthorized rows from being returned, but pgvector applies ordinary dynamic filters after scanning ANN candidates. Highly selective opportunity/source/grant filters can therefore underfill results. Iterative scans continue through more graph candidates until enough permitted rows are found or bounded scan/memory limits are reached.

Dedicated promoted security-domain relations prevent standard searches from traversing restricted or sensitive-pricing vectors. Dynamic source and opportunity predicates remain in the query. Final output confidentiality is proved by the final relation:

```text
final candidates = ANN candidate IDs JOIN current authorized rows
```

Thus every returned/persisted row is authorized. Shared-graph timing and recall noninterference is not claimed. If the production threat model treats statistically observable latency/recall effects as disclosure, use physically isolated tenant/domain relations or a native prefiltered-ANN adapter behind the same interface.

## Routing and failure behavior

- Small authorized domain: exact search.
- Promoted large domain: HNSW with iterative scans and exact reranking.
- HNSW underfill: one bounded higher-scan tier.
- Continued underfill or index failure: exact search when within the exact-work budget.
- Unbounded exact work or profile/policy/index integrity failure: typed `RETRIEVAL_UNAVAILABLE`.
- Authorization failure: opaque denial, no fallback, no manifest.
- Existing manifest: replay before considering current index health.

An internal per-profile/domain kill switch returns traffic to exact search without changing callers or rewriting manifests.

## Activation gates

HNSW remains shadow-only until all gates pass on realistic authorized scopes:

- permission and metadata leakage = `0`;
- mandatory policy inclusion = `100%`;
- citation authorization and manifest membership = `100%`;
- semantic recall@20 versus exact authorized cosine >= `0.95` overall and >= `0.98` for commercial/policy-sensitive cohorts;
- final hybrid overlap@20 versus exact hybrid >= `0.97`;
- candidate underfill < `0.1%`;
- at least `2x` p95 semantic-query latency improvement after exact reranking;
- no mixed embedding profiles or stale content hashes;
- index build, memory, WAL, vacuum, replica lag, recovery, and blue/green rebuild SLOs pass.

Nightly stratified evaluation and sampled shadow traffic compare HNSW against exact search over the identical authorized universe. A failing domain automatically returns to exact mode.

## Migration and rollout

1. Keep current exact behavior and tests as the oracle.
2. Add profile, security-domain, projection, and index-generation metadata.
3. Probe the live embedding profile; create a fixed-dimensional projection generation.
4. Backfill and verify one-to-one evidence ID/content-hash/profile coverage.
5. Build HNSW relations concurrently for eligible domains.
6. Shadow HNSW while returning exact results.
7. Canary eligible domains at 1%, 10%, and 50% after gates pass.
8. Activate by profile/domain with exact fallback and a kill switch.
9. Build new profile generations blue/green; old manifests remain replayable until retention expires.

## Primary references

- [pgvector HNSW, filtering, iterative scans, multitenancy, and recall monitoring](https://github.com/pgvector/pgvector)
- [PostgreSQL declarative partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)
