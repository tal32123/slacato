import type { AccountId, EvidenceId, OpportunityId } from '../../domain/shared/ids.js';

/** Canonical embedding identity. Every element participates in comparison compatibility. */
export type EmbeddingProfile = Readonly<{
  provider: string;
  model: string;
  dimension: number;
  profile: string;
  version: string;
  normalization: string;
}>;
export type ExactEvidenceQuery = Readonly<{
  accountId: AccountId;
  opportunityId?: OpportunityId | undefined;
  embedding: readonly number[];
  profile: EmbeddingProfile;
  limit: number;
}>;
export type EvidenceMatch = Readonly<{ evidenceId: EvidenceId; similarity: number }>;

/** Authorization-scoped exact vector lookup. Callers must never compare profile-mismatched embeddings. */
export interface EvidenceRepository {
  searchExactCosine(input: ExactEvidenceQuery): Promise<readonly EvidenceMatch[]>;
}

export function assertEmbeddingComparison(input: ExactEvidenceQuery): void {
  if (!Number.isInteger(input.profile.dimension) || input.profile.dimension <= 0) throw new Error('Embedding profile dimension must be positive');
  if (input.embedding.length !== input.profile.dimension) throw new Error('Embedding dimension does not match the requested profile');
  let squaredNorm = 0;
  for (const value of input.embedding) {
    if (!Number.isFinite(value)) throw new Error('Embedding contains a non-finite value');
    squaredNorm += value * value;
  }
  if (squaredNorm === 0) throw new Error('Zero embeddings cannot participate in cosine comparison');
}
