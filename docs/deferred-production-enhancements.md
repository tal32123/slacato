# Deferred Production Enhancements

This document records production capabilities deliberately excluded from the take-home baseline. They are not missing assignment requirements and must not be described as implemented.

The baseline favors controls that are easy to inspect and verify on the small synthetic corpus. The production trigger for each enhancement is explicit so a future team can add it without weakening authorization, grounding, or reproducibility.

## HNSW is no longer deferred

HNSW was selected after three independent architecture reviews. It now belongs to the implementation architecture, not this “would do later” list. The design uses adaptive exact/HNSW routing, promoted security domains, iterative scans, exact reranking and fallback, and explicit recall/leakage activation gates. See [Adaptive Authorized HNSW Retrieval](hnsw-retrieval-architecture.md).

## Microsoft Presidio PII detection

**Status:** Not implemented. Candidate production defense in depth.

**Why it is not a baseline dependency:** The take-home uses a small, synthetic, English-language fixture set. Deterministic checks for emails, phones, known real/customer names, sensitive identifiers, fixture novelty, plus required human review are simpler to audit in the TypeScript pipeline. Presidio introduces Python/NLP models or extra containerized HTTP services. Its documentation also warns that automated detection cannot guarantee finding every sensitive value.

**What we would do in production:**

- Run Presidio Analyzer as a pinned, private container at ingestion and before promoting generated free-form Slack evidence.
- Add custom recognizers for customer identifiers, internal opportunity/account patterns, and company-specific sensitive terms.
- Keep deterministic regex/checksum/deny-list validation and human review; Presidio augments rather than replaces them.
- Treat service failure or low-confidence results according to source risk: fail closed for generated evidence promotion and quarantine ambiguous records for review.
- Record recognizer/model/version and safe result metadata without logging source bodies or detected PII.
- Do not send ordinary structured logs through Presidio. Continue suppressing prompts, completions, source bodies, cookies, authorization headers, and secrets at the logging interface.
- Evaluate precision and recall on a labeled, organization-specific PII corpus before activation.

Primary references: [Presidio overview and limitations](https://microsoft.github.io/presidio/) and [installation/deployment](https://microsoft.github.io/presidio/installation/).

## Cost-aware model routing

**Status:** Not implemented; token, context, call, retry, output, and deadline budgets are implemented/planned independently.

Add routing only when at least two approved live models have measured quality, latency, and cost profiles for every agent contract. The router must stay behind the model-gateway seam and may never choose a model that fails the required structured-output, context, privacy, or residency capabilities.

## Synthetic labeled evaluation-data generation

**Status:** Not implemented. Golden retrieval/security fixtures and deterministic regressions are used instead.

Add a generator only after defining label schemas, independent review, provenance, contamination controls, and acceptance thresholds. Generated labels must never silently become ground truth without human validation.

## Cross-encoder reranking

**Status:** Deferred until the hybrid baseline is measured.

Prototype reranking only if exact/HNSW semantic search plus FTS and RRF misses the required relevance threshold. Measure incremental relevance against added latency, cost, context exposure, and operational complexity before adoption.
