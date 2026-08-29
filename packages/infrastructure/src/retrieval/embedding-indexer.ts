import type { EmbeddingGateway, EmbeddingProfile } from '@slacato/core';
import type { DatabaseClient } from '../db/client.js';

type ProfileRow = Readonly<{
  provider: string; model: string; dimension: number; profile: string; version: string; normalization: string;
}>;
type ChunkRow = Readonly<{ id: string; content: string }>;

function vectorLiteral(values: readonly number[]): string { return `[${values.join(',')}]`; }
function profileKey(profile: EmbeddingProfile): string {
  return [profile.provider, profile.model, profile.dimension, profile.profile, profile.version, profile.normalization].join('\u001f');
}

export type EmbeddingIndexResult = Readonly<{ indexed: number; skipped: number; batches: number }>;
export type EmbeddingCorpusScope = Readonly<{
  sourceLocatorPrefixes: readonly string[];
  requireCompleteProvenance: boolean;
}>;

/** One-time, profile-safe embedding writer for immutable evidence versions. */
export class EmbeddingIndexer {
  private readonly batchSize: number;
  private readonly corpus: EmbeddingCorpusScope | undefined;

  public constructor(
    private readonly database: DatabaseClient,
    private readonly gateway: EmbeddingGateway,
    private readonly profile: EmbeddingProfile,
    options: Readonly<{ batchSize?: number; corpus?: EmbeddingCorpusScope }> = {}
  ) {
    this.batchSize = options.batchSize ?? 32;
    this.corpus = options.corpus;
    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0 || this.batchSize > 256) throw new Error('Embedding batch size must be between 1 and 256');
    if (!Number.isInteger(profile.dimension) || profile.dimension <= 0) throw new Error('Embedding profile dimension must be positive');
    for (const value of [profile.provider, profile.model, profile.profile, profile.version, profile.normalization]) {
      if (value.trim().length === 0) throw new Error('Embedding profile fields must not be empty');
    }
    if (this.corpus !== undefined && (this.corpus.sourceLocatorPrefixes.length === 0 || this.corpus.sourceLocatorPrefixes.some((prefix) => prefix.length === 0))) {
      throw new Error('Embedding corpus locator prefixes must not be empty');
    }
  }

  public async index(): Promise<EmbeddingIndexResult> {
    if (this.corpus?.requireCompleteProvenance === true) {
      const incomplete = await this.database.sql<{ count: number }[]>`
        select count(*)::integer as count from evidence_versions evidence
        join document_versions document on document.id = evidence.document_version_id
        where ${this.corpusCandidatePredicate()} and not (${this.completeProvenancePredicate()})
      `;
      if ((incomplete[0]?.count ?? 0) > 0) throw new Error('Canonical embedding corpus provenance is incomplete');
    }
    const existing = await this.database.sql<ProfileRow[]>`
      select distinct embedding_provider as provider, embedding_model as model, embedding_dimension as dimension,
        embedding_profile as profile, embedding_version as version, embedding_normalization as normalization
      from evidence_versions evidence join document_versions document on document.id = evidence.document_version_id
      where evidence.embedding is not null ${this.corpusPredicate()}
    `;
    if (existing.some((entry) => profileKey(entry) !== profileKey(this.profile))) {
      throw new Error('Refusing mixed embedding profiles; re-embedding requires an explicit deployment migration');
    }
    const totals = await this.database.sql<{ total: number; pending: number }[]>`
      select count(*)::integer as total, count(*) filter (where evidence.embedding is null)::integer as pending
      from evidence_versions evidence join document_versions document on document.id = evidence.document_version_id
      where true ${this.corpusPredicate()}
    `;
    const skipped = (totals[0]?.total ?? 0) - (totals[0]?.pending ?? 0);
    let indexed = 0;
    let batches = 0;
    while (true) {
      const chunks = await this.database.sql<ChunkRow[]>`
        select evidence.id, evidence.content from evidence_versions evidence
        join document_versions document on document.id = evidence.document_version_id
        where evidence.embedding is null ${this.corpusPredicate()} order by evidence.id asc limit ${this.batchSize}
      `;
      if (chunks.length === 0) break;
      const embeddings = await this.gateway.embed(chunks.map((chunk) => chunk.content));
      if (embeddings.length !== chunks.length) throw new Error('Embedding provider returned the wrong batch cardinality');
      embeddings.forEach((embedding, index) => this.assertEmbedding(embedding, chunks[index]!.id));
      const updated = await this.database.sql.begin(async (transaction) => {
        let count = 0;
        for (let index = 0; index < chunks.length; index += 1) {
          const rows = await transaction`update evidence_versions set
              embedding = ${vectorLiteral(embeddings[index]!)}::vector,
              embedding_provider = ${this.profile.provider}, embedding_model = ${this.profile.model},
              embedding_dimension = ${this.profile.dimension}, embedding_profile = ${this.profile.profile},
              embedding_version = ${this.profile.version}, embedding_normalization = ${this.profile.normalization},
              embedding_content_hash = content_hash
            where id = ${chunks[index]!.id} and embedding is null returning id`;
          count += rows.length;
        }
        return count;
      });
      indexed += updated;
      batches += 1;
      if (updated === 0) {
        const winnerProfiles = await this.database.sql<ProfileRow[]>`
          select distinct embedding_provider as provider, embedding_model as model, embedding_dimension as dimension,
            embedding_profile as profile, embedding_version as version, embedding_normalization as normalization
          from evidence_versions where id = any(${chunks.map((chunk) => chunk.id)}::text[]) and embedding is not null
        `;
        if (winnerProfiles.length !== 1 || profileKey(winnerProfiles[0]!) !== profileKey(this.profile)) {
          throw new Error('Refusing mixed embedding profiles; a different profile won the concurrent write');
        }
      }
    }
    return { indexed, skipped, batches };
  }

  private corpusPredicate() {
    if (this.corpus === undefined) return this.database.sql``;
    const provenance = this.corpus.requireCompleteProvenance
      ? this.database.sql`and ${this.corpusCandidatePredicate()} and ${this.completeProvenancePredicate()}`
      : this.database.sql`and ${this.corpusCandidatePredicate()}`;
    return provenance;
  }

  private corpusCandidatePredicate() {
    if (this.corpus === undefined) return this.database.sql`true`;
    const prefixes = this.corpus.sourceLocatorPrefixes.map((prefix) => `${prefix}%`);
    return this.database.sql`(evidence.source_locator like any(${prefixes}::text[]) or document.source_locator like any(${prefixes}::text[]))`;
  }

  private completeProvenancePredicate() {
    const prefixes = this.corpus?.sourceLocatorPrefixes.map((prefix) => `${prefix}%`) ?? [];
    return this.database.sql`evidence.reliability_class is not null and evidence.classification_reason is not null
      and evidence.policy_hash ~ '^[0-9a-f]{64}$' and evidence.source_locator like any(${prefixes}::text[])
      and document.reliability_class is not null and document.classification_reason is not null
      and document.policy_hash = evidence.policy_hash and document.source_locator like any(${prefixes}::text[])
      and document.source_type = evidence.source_type`;
  }

  private assertEmbedding(embedding: readonly number[], evidenceId: string): void {
    if (embedding.length !== this.profile.dimension) throw new Error(`Embedding dimension mismatch for ${evidenceId}`);
    const norm = Math.sqrt(embedding.reduce((sum, value) => {
      if (!Number.isFinite(value)) throw new Error(`Non-finite embedding value for ${evidenceId}`);
      return sum + value * value;
    }, 0));
    if (norm === 0) throw new Error(`Zero embedding returned for ${evidenceId}`);
    if (this.profile.normalization === 'l2' && Math.abs(norm - 1) > 0.001) throw new Error(`Embedding is not unit normalized for ${evidenceId}`);
  }
}
