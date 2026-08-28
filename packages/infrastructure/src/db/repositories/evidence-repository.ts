import { assertEmbeddingComparison, type EvidenceMatch, type EvidenceRepository, type ExactEvidenceQuery } from '@slacato/core';
import type { DatabaseClient } from '../client.js';

type MatchRow = Readonly<{ id: string; similarity: number | string }>;
function vectorLiteral(values: readonly number[]): string { return `[${values.join(',')}]`; }

/** pgvector exact-cosine adapter. Authorization and the complete profile tuple filter before distance ranking. */
export class PostgresEvidenceRepository implements EvidenceRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async searchExactCosine(input: ExactEvidenceQuery): Promise<readonly EvidenceMatch[]> {
    assertEmbeddingComparison(input);
    const rows = await this.database.sql<MatchRow[]>`
      select id, (1 - (embedding <=> ${vectorLiteral(input.embedding)}::vector)) as similarity
      from evidence_versions
      where account_id = ${input.accountId}
        and opportunity_id is not distinct from ${input.opportunityId ?? null}
        and embedding is not null
        and vector_dims(embedding) = ${input.profile.dimension}
        and vector_norm(embedding) > 0
        and embedding_provider = ${input.profile.provider}
        and embedding_model = ${input.profile.model}
        and embedding_dimension = ${input.profile.dimension}
        and embedding_profile = ${input.profile.profile}
        and embedding_version = ${input.profile.version}
        and embedding_normalization = ${input.profile.normalization}
      order by embedding <=> ${vectorLiteral(input.embedding)}::vector, id asc
      limit ${input.limit}
    `;
    return rows.map((row) => ({ evidenceId: row.id as EvidenceMatch['evidenceId'], similarity: Number(row.similarity) }));
  }
}
