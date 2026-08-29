import {
  assertEmbeddingComparison,
  CANONICAL_FIXTURE_COMMIT,
  type EvidenceMatch,
  type EvidenceRepository,
  type ExactEvidenceQuery
} from '@slacato/core';
import type { DatabaseClient } from '../client.js';

type MatchRow = Readonly<{
  id: string;
  similarity: number | string;
}>;

/** Formats numeric values as a PostgreSQL vector literal. */
function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

/** Finds embedded evidence that the requesting persona is allowed to read. */
export class PostgresEvidenceRepository implements EvidenceRepository {
  /** Creates an evidence repository backed by the provided database client. */
  public constructor(private readonly database: DatabaseClient) {}

  /** Returns exact-cosine matches after applying account, source, and sensitivity permissions. */
  public async searchExactCosine(input: ExactEvidenceQuery): Promise<readonly EvidenceMatch[]> {
    assertEmbeddingComparison(input);
    const rows = await this.database.sql<MatchRow[]>`
      select evidence.id, (1 - (evidence.embedding <=> ${vectorLiteral(input.embedding)}::vector)) as similarity
      from evidence_versions evidence
      join authorized_evidence_grants evidence_grant
        on evidence_grant.evidence_id = evidence.id
        and evidence_grant.persona_id = ${input.access.personaId}
        and evidence_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
      where evidence.account_id = ${input.accountId}
        and evidence.opportunity_id is not distinct from ${input.opportunityId ?? null}
        and evidence.embedding is not null
        and vector_dims(evidence.embedding) = ${input.profile.dimension}
        and vector_norm(evidence.embedding) > 0
        and evidence.embedding_provider = ${input.profile.provider}
        and evidence.embedding_model = ${input.profile.model}
        and evidence.embedding_dimension = ${input.profile.dimension}
        and evidence.embedding_profile = ${input.profile.profile}
        and evidence.embedding_version = ${input.profile.version}
        and evidence.embedding_normalization = ${input.profile.normalization}
      order by evidence.embedding <=> ${vectorLiteral(input.embedding)}::vector, evidence.id asc
      limit ${input.limit}
    `;
    return rows.map((row) => ({
      evidenceId: row.id as EvidenceMatch['evidenceId'],
      similarity: Number(row.similarity)
    }));
  }
}
