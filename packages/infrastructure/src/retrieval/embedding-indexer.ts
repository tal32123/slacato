import type { EmbeddingGateway, EmbeddingProfile } from '@slacato/core';
import type { Sql, TransactionSql } from 'postgres';
import type { DatabaseClient } from '../db/client.js';

type ProfileRow = Readonly<{
  provider: string;
  model: string;
  dimension: number;
  profile: string;
  version: string;
  normalization: string;
}>;
type ChunkRow = Readonly<{ id: string; content: string }>;
type PreparedChunk = ChunkRow & Readonly<{ embedding: readonly number[] }>;
type SqlExecutor = Sql | TransactionSql;

/** Formats an embedding for PostgreSQL vector storage. */
function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}
/** Produces a stable identity for an embedding profile. */
function profileKey(profile: EmbeddingProfile): string {
  return [
    profile.provider,
    profile.model,
    profile.dimension,
    profile.profile,
    profile.version,
    profile.normalization
  ].join('\u001f');
}

export type EmbeddingIndexResult = Readonly<{ indexed: number; skipped: number; batches: number }>;
export type EmbeddingCorpusScope = Readonly<{
  sourceLocatorPrefixes: readonly string[];
  requireCompleteProvenance: boolean;
}>;

/** Prepares embeddings in bounded batches, then atomically activates one profile for the selected evidence corpus. */
export class EmbeddingIndexer {
  private readonly batchSize: number;
  private readonly corpus: EmbeddingCorpusScope | undefined;

  /** Configures the embedding profile, batch size, and evidence corpus to index. */
  public constructor(
    private readonly database: DatabaseClient,
    private readonly gateway: EmbeddingGateway,
    private readonly profile: EmbeddingProfile,
    options: Readonly<{ batchSize?: number; corpus?: EmbeddingCorpusScope }> = {}
  ) {
    this.batchSize = options.batchSize ?? 32;
    this.corpus = options.corpus;
    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0 || this.batchSize > 256)
      throw new Error('Embedding batch size must be between 1 and 256');
    if (!Number.isInteger(profile.dimension) || profile.dimension <= 0)
      throw new Error('Embedding profile dimension must be positive');
    for (const value of [
      profile.provider,
      profile.model,
      profile.profile,
      profile.version,
      profile.normalization
    ]) {
      if (value.trim().length === 0) throw new Error('Embedding profile fields must not be empty');
    }
    if (
      this.corpus !== undefined &&
      (this.corpus.sourceLocatorPrefixes.length === 0 ||
        this.corpus.sourceLocatorPrefixes.some((prefix) => prefix.length === 0))
    ) {
      throw new Error('Embedding corpus locator prefixes must not be empty');
    }
  }

  /** Indexes the selected corpus without exposing partial or mixed profile writes. */
  public async index(): Promise<EmbeddingIndexResult> {
    await this.assertCompatibleCorpus(this.database.sql);
    const prepared: PreparedChunk[] = [];
    let batches = 0;
    let cursor: string | undefined;
    while (true) {
      const cursorPredicate =
        cursor === undefined ? this.database.sql`` : this.database.sql`and evidence.id > ${cursor}`;
      const chunks = await this.database.sql<ChunkRow[]>`
        select evidence.id, evidence.content from evidence_versions evidence
        join document_versions document on document.id = evidence.document_version_id
        where evidence.embedding is null ${this.corpusPredicate(this.database.sql)} ${cursorPredicate}
        order by evidence.id asc limit ${this.batchSize}
      `;
      if (chunks.length === 0) break;
      const embeddings = await this.gateway.embed(chunks.map((chunk) => chunk.content));
      if (embeddings.length !== chunks.length)
        throw new Error('Embedding provider returned the wrong batch cardinality');
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const embedding = embeddings[index];
        if (chunk === undefined || embedding === undefined)
          throw new Error('Embedding provider returned the wrong batch cardinality');
        this.assertEmbedding(embedding, chunk.id);
        prepared.push({ ...chunk, embedding });
        cursor = chunk.id;
      }
      batches += 1;
    }

    const preparedIds = new Set(prepared.map((chunk) => chunk.id));
    return this.database.sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext(${'embedding-index:evidence-versions'}))`;
      await this.assertCompatibleCorpus(transaction);
      const pending = await transaction<ChunkRow[]>`
        select evidence.id, evidence.content from evidence_versions evidence
        join document_versions document on document.id = evidence.document_version_id
        where evidence.embedding is null ${this.corpusPredicate(transaction)}
        order by evidence.id asc
      `;
      if (pending.some((chunk) => !preparedIds.has(chunk.id))) {
        throw new Error('Evidence corpus changed while embeddings were prepared; rerun indexing');
      }

      let indexed = 0;
      for (const chunk of prepared) {
        const rows = await transaction`update evidence_versions set
            embedding = ${vectorLiteral(chunk.embedding)}::vector,
            embedding_provider = ${this.profile.provider}, embedding_model = ${this.profile.model},
            embedding_dimension = ${this.profile.dimension}, embedding_profile = ${this.profile.profile},
            embedding_version = ${this.profile.version}, embedding_normalization = ${this.profile.normalization},
            embedding_content_hash = content_hash
          where id = ${chunk.id} and embedding is null returning id`;
        indexed += rows.length;
      }
      const totals = await transaction<{ total: number; pending: number }[]>`
        select count(*)::integer as total, count(*) filter (where evidence.embedding is null)::integer as pending
        from evidence_versions evidence join document_versions document on document.id = evidence.document_version_id
        where true ${this.corpusPredicate(transaction)}
      `;
      if ((totals[0]?.pending ?? 0) !== 0)
        throw new Error('Evidence corpus changed while embeddings were activated; rerun indexing');
      await this.assertCompatibleCorpus(transaction);
      return { indexed, skipped: (totals[0]?.total ?? 0) - indexed, batches };
    });
  }

  /** Rejects incomplete provenance or any active profile other than the requested one. */
  private async assertCompatibleCorpus(sql: SqlExecutor): Promise<void> {
    if (this.corpus?.requireCompleteProvenance === true) {
      const incomplete = await sql<{ count: number }[]>`
        select count(*)::integer as count from evidence_versions evidence
        join document_versions document on document.id = evidence.document_version_id
        where ${this.corpusCandidatePredicate(sql)} and not (${this.completeProvenancePredicate(sql)})
      `;
      if ((incomplete[0]?.count ?? 0) > 0)
        throw new Error('Canonical embedding corpus provenance is incomplete');
    }
    const existing = await sql<ProfileRow[]>`
      select distinct embedding_provider as provider, embedding_model as model, embedding_dimension as dimension,
        embedding_profile as profile, embedding_version as version, embedding_normalization as normalization
      from evidence_versions evidence join document_versions document on document.id = evidence.document_version_id
      where evidence.embedding is not null ${this.corpusPredicate(sql)}
    `;
    if (existing.some((entry) => profileKey(entry) !== profileKey(this.profile))) {
      throw new Error(
        'Refusing mixed embedding profiles; re-embedding requires an explicit deployment migration'
      );
    }
  }

  /** Builds the SQL restriction for the configured evidence corpus. */
  private corpusPredicate(sql: SqlExecutor) {
    if (this.corpus === undefined) return sql``;
    const provenance = this.corpus.requireCompleteProvenance
      ? sql`and ${this.corpusCandidatePredicate(sql)} and ${this.completeProvenancePredicate(sql)}`
      : sql`and ${this.corpusCandidatePredicate(sql)}`;
    return provenance;
  }

  /** Matches evidence or parent documents within the configured locator prefixes. */
  private corpusCandidatePredicate(sql: SqlExecutor) {
    if (this.corpus === undefined) return sql`true`;
    const prefixes = this.corpus.sourceLocatorPrefixes.map((prefix) => `${prefix}%`);
    return sql`(evidence.source_locator like any(${prefixes}::text[]) or document.source_locator like any(${prefixes}::text[]))`;
  }

  /** Requires complete and consistent provenance on both a chunk and its parent document. */
  private completeProvenancePredicate(sql: SqlExecutor) {
    const prefixes = this.corpus?.sourceLocatorPrefixes.map((prefix) => `${prefix}%`) ?? [];
    return sql`evidence.reliability_class is not null and evidence.classification_reason is not null
      and evidence.policy_hash ~ '^[0-9a-f]{64}$' and evidence.source_locator like any(${prefixes}::text[])
      and document.reliability_class is not null and document.classification_reason is not null
      and document.policy_hash = evidence.policy_hash and document.source_locator like any(${prefixes}::text[])
      and document.source_type = evidence.source_type`;
  }

  /** Rejects provider embeddings that cannot safely join the active search index. */
  private assertEmbedding(embedding: readonly number[], evidenceId: string): void {
    if (embedding.length !== this.profile.dimension)
      throw new Error(`Embedding dimension mismatch for ${evidenceId}`);
    const norm = Math.sqrt(
      embedding.reduce((sum, value) => {
        if (!Number.isFinite(value))
          throw new Error(`Non-finite embedding value for ${evidenceId}`);
        return sum + value * value;
      }, 0)
    );
    if (norm === 0) throw new Error(`Zero embedding returned for ${evidenceId}`);
    if (this.profile.normalization === 'l2' && Math.abs(norm - 1) > 0.001)
      throw new Error(`Embedding is not unit normalized for ${evidenceId}`);
  }
}
