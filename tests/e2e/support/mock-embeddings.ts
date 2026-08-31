/**
 * Computes evidence embeddings identical to `scripts/index-embeddings.ts`'s mock provider, so
 * fixtures that insert `evidence_versions` rows directly (bypassing `pnpm index:embeddings`) can
 * still carry an embedding profile that matches the one the e2e webServer indexes with
 * (`AI_PROVIDER=mock`, see `playwright.config.ts`).
 *
 * This matters because `packages/infrastructure/src/health/readiness-probes.ts`'s `index` check
 * scans ALL of `evidence_versions` -- not just the canonical corpus `EmbeddingIndexer` scopes
 * itself to -- and requires every row's embedding to match a single profile
 * (`count(distinct row(embedding_provider, embedding_model, embedding_dimension,
 * embedding_profile, embedding_version, embedding_normalization)) = 1`). A fixture row seeded
 * with no embedding at all, or an embedding under a different profile, flips that check to
 * "unavailable" for the whole deployment, which the UI's generation-readiness gate then correctly
 * reads as "Generate Brief" being unsafe to offer -- see run-resume.spec.ts's prior failure mode.
 *
 * The import is dynamic and deferred to call time (not a top-level import) because Playwright
 * collects/imports every spec file before its `webServer` commands are guaranteed to have run
 * `pnpm build`; `@slacato/infrastructure`'s package.json `exports` resolve to `dist/`, which only
 * exists once that build has completed. Deferring the import until a fixture actually seeds
 * (well after the server -- and therefore the build -- is up) avoids a collection-time failure on
 * a clean checkout.
 */

/** The exact profile `scripts/index-embeddings.ts` activates for `AI_PROVIDER=mock`. */
export const MOCK_EMBEDDING_PROFILE_COLUMNS = Object.freeze({
  embeddingProvider: 'mock',
  embeddingModel: 'mock-embedding',
  embeddingDimension: 64,
  embeddingProfile: 'mock-token-hash-64',
  embeddingVersion: 'v1',
  embeddingNormalization: 'l2'
});

let cachedGateway: Promise<{ embed(values: readonly string[]): Promise<number[][]> }> | undefined;

/** Lazily builds the same mock embedding gateway `scripts/index-embeddings.ts` uses. */
function mockEmbeddingGateway(): Promise<{ embed(values: readonly string[]): Promise<number[][]> }> {
  cachedGateway ??= import('@slacato/infrastructure').then(({ createMockModelGateways }) => {
    const unusedGenerationLedger = {
      async beginAttempt(): Promise<never> {
        throw new Error('Generation is unavailable in the mock-embedding test fixture');
      },
      async settleAttempt(): Promise<void> {},
      async releaseAttempt(): Promise<void> {}
    };
    const mock = createMockModelGateways({
      resolve: () => ({ text: '{}' }),
      attemptLedger: unusedGenerationLedger
    });
    return mock.embeddingGateway;
  });
  return cachedGateway;
}

/** Computes a `[...]` pgvector literal for `content` under the e2e mock embedding profile. */
export async function mockEmbeddingVectorLiteral(content: string): Promise<string> {
  const gateway = await mockEmbeddingGateway();
  const [embedding] = await gateway.embed([content]);
  if (embedding === undefined) throw new Error('Mock embedding gateway returned no vector');
  return `[${embedding.join(',')}]`;
}
