# Model provider compatibility gates

## Accepted initial-release mock profile

`AI_PROVIDER=mock` is the accepted initial-release development/demo gate. It is
not Ollama and must never be represented as live compatibility: registry IDs
are `mock-*`, generation results include the `mock_provider` warning, and its
documented profile is `mock/mock-embedding`, dimension **64**, deterministic
token-hashing/bag-of-words, unit-normalized for non-empty strings. Empty or
whitespace-only strings produce the zero vector. It uses no network, key, or
randomness. This dimension is a mock-only profile, not an inferred or approved
Ollama dimension. `mock` is the default provider mode, not a self-generating
model: composition must supply a type-safe scriptable fixture resolver (Task 8
or API composition owns those fixtures) and fails immediately if it is absent.

Task 3 must use a dimension-flexible pgvector column, persist model, dimension,
and profile metadata with embeddings, and reject cross-profile comparisons in
application invariants. The initial baseline remains exact authorized-subset
search with no HNSW. Switching to a real model requires a full re-embedding,
an explicit pre-production migration/operational gate, and refreshed profile
metadata; it is not runtime model switching.

## Ollama Cloud production gate

Status on 2026-08-28: **explicitly unverified**. `OLLAMA_API_KEY` is absent in this workspace, so no generation or embedding capability has been inferred, and no embedding dimension, vector normalization behavior, model availability, or native structured-output support is claimed. `AI_PROVIDER=ollama` strictly requires `OLLAMA_API_KEY`, `OLLAMA_CHAT_MODEL`, and `OLLAMA_EMBEDDING_MODEL`; mock mode requires none of them.

The deployed configuration, rather than source code, selects `OLLAMA_CHAT_MODEL` and `OLLAMA_EMBEDDING_MODEL`. The private Ollama adapter creates its provider with `createOllama({ baseURL: OLLAMA_BASE_URL, headers: { Authorization: \`Bearer ...\` } })`; it creates embeddings through the public `.embedding(modelId)` factory. The adapter calls AI SDK `generateText` with `Output.object({ schema })` only when this probe observes native support, and otherwise uses the core prompted-JSON fallback. Both `generateText` and `embedMany` explicitly set `maxRetries: 0` so the shared core controller remains the only retry/call/deadline/budget owner.

This follows the installed `ai@7.0.83` sources and bundled docs:

- `packages/core/node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx` documents `generateText` plus `Output.object({ schema })`.
- `packages/core/node_modules/ai/src/generate-text/generate-text.ts` documents `maxRetries: 0` as disabling SDK retries.
- `packages/core/node_modules/ai/src/embed/embed-many.ts` documents `embedMany({ model, values, maxRetries: 0 })`.
- `packages/infrastructure/node_modules/ollama-ai-provider-v2/README.md` and `dist/index.d.ts` document `createOllama`, bearer headers, and `.embedding(modelId)` for `ollama-ai-provider-v2@4.0.1`.

## Required credentialed gate before production AI mode

Run:

```bash
LIVE_AI=1 OLLAMA_API_KEY=... OLLAMA_CHAT_MODEL=... OLLAMA_EMBEDDING_MODEL=... \
  pnpm vitest run tests/contract/ollama-live.test.ts
```

The test performs a separate `/api/tags` discovery probe, a native-schema probe, an embedding probe, and all four real agent-schema checks. It deliberately fails (rather than skipping or reporting success) if `LIVE_AI=1` lacks a required credential/model variable. On success, copy the observed model IDs, embedding dimension, normalization observation, native-schema result, and warnings below before enabling production Ollama generation.

| Field | Observed value |
| --- | --- |
| Generation model ID | Pending credentialed probe |
| Embedding model ID | Pending credentialed probe |
| Embedding dimension | Pending credentialed probe; never hardcoded |
| Unit normalized | Pending credentialed probe |
| Native schema support | Pending credentialed probe |
| Provider warnings | Pending credentialed probe |
