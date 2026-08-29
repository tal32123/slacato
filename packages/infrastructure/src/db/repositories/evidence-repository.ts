import {
  assertEmbeddingComparison,
  type EvidenceMatch,
  type EvidenceRepository,
  type ExactEvidenceQuery
} from '@slacato/core';
import type { DatabaseClient } from '../client.js';

type MatchRow = Readonly<{
  id: string;
  similarity: number | string;
}>;

function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

/** Finds embedded evidence that the requesting persona is allowed to read. */
export class PostgresEvidenceRepository implements EvidenceRepository {
  public constructor(private readonly database: DatabaseClient) {}

  /** Returns exact-cosine matches after applying account, source, and sensitivity permissions. */
  public async searchExactCosine(input: ExactEvidenceQuery): Promise<readonly EvidenceMatch[]> {
    assertEmbeddingComparison(input);
    const rows = await this.database.sql<MatchRow[]>`
      select evidence.id, (1 - (evidence.embedding <=> ${vectorLiteral(input.embedding)}::vector)) as similarity
      from evidence_versions evidence
      join opportunities opportunity on opportunity.id = evidence.opportunity_id
      where evidence.account_id = ${input.accountId}
        and opportunity_id is not distinct from ${input.opportunityId ?? null}
        and (
          evidence.sensitivity <> 'restricted'
          or (evidence.source_type = 'pricing' and ${input.access.allowSensitivePricing} = true)
          or evidence.source_type <> 'pricing'
        )
        and evidence.embedding is not null
        and vector_dims(evidence.embedding) = ${input.profile.dimension}
        and vector_norm(evidence.embedding) > 0
        and evidence.embedding_provider = ${input.profile.provider}
        and evidence.embedding_model = ${input.profile.model}
        and evidence.embedding_dimension = ${input.profile.dimension}
        and evidence.embedding_profile = ${input.profile.profile}
        and evidence.embedding_version = ${input.profile.version}
        and evidence.embedding_normalization = ${input.profile.normalization}
        and exists (
          select 1
          from permission_grants permission
          where permission.persona_id = ${input.access.personaId}
            and permission.can_read = true
            and (permission.account_id is null or permission.account_id = evidence.account_id)
            and (permission.source_type is null or permission.source_type = evidence.source_type)
            and (opportunity.restricted = false or permission.can_read_restricted = true)
            and (
              evidence.sensitivity <> 'restricted'
              or (evidence.source_type = 'pricing' and permission.sensitive_pricing = true)
              or (evidence.source_type <> 'pricing' and permission.can_read_restricted = true)
            )
        )
      order by evidence.embedding <=> ${vectorLiteral(input.embedding)}::vector, evidence.id asc
      limit ${input.limit}
    `;
    return rows.map((row) => ({
      evidenceId: row.id as EvidenceMatch['evidenceId'],
      similarity: Number(row.similarity)
    }));
  }
}
