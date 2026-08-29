import { createHash } from 'node:crypto';
import {
  applyEvidenceAdjustments,
  buildEvidencePlan,
  opaqueCitationDenial,
  reciprocalRankFusion,
  type AuthorizedCitation,
  type CitationResolutionRequest,
  type CitationResolver,
  type EmbeddingGateway,
  type EmbeddingProfile,
  type EvidenceRetriever,
  type RetrievedEvidence,
  type RetrievalRequest,
  type RetrievalResult
} from '@slacato/core';
import type { AuthorizedSourceType } from '@slacato/core';
import type { DatabaseClient } from '../db/client.js';

type SearchRow = Readonly<{
  id: string; content: string; content_hash: string; source_type: AuthorizedSourceType; sensitivity: string;
  event_date: string | null; reliability_class: string; source_locator: string; classification_reason: string; policy_hash: string;
}>;
type CitationRow = Readonly<{ citation_id: string; evidence_id: string; content: string; source_type: AuthorizedSourceType; source_locator: string }>;

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function vectorLiteral(values: readonly number[]): string { return `[${values.join(',')}]`; }
function citationId(manifestId: string, evidenceId: string): RetrievedEvidence['citationId'] {
  return `citation_${sha256(`${manifestId}\u001f${evidenceId}`).slice(0, 40)}` as RetrievedEvidence['citationId'];
}

/** PostgreSQL FTS + exact cosine adapter; both candidate queries rank only their authorized CTE. */
export class PostgresHybridEvidenceRetriever implements EvidenceRetriever {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly profile: EmbeddingProfile,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async search(request: RetrievalRequest): Promise<RetrievalResult> {
    const plan = buildEvidencePlan(request);
    const queryHash = sha256(plan.query.normalize('NFKC'));
    const scopeHash = sha256(stableJson({
      personaId: request.scope.personaId,
      accountIds: [...request.scope.accountIds].sort(),
      sourceTypes: [...request.scope.sourceTypes].sort(),
      canViewSensitivePricing: request.scope.canViewSensitivePricing,
      canViewRestrictedAccounts: request.scope.canViewRestrictedAccounts
    }));
    const manifestId = `manifest_${sha256(`${request.runId}\u001f${queryHash}\u001f${scopeHash}`).slice(0, 40)}`;
    if (!request.scope.accountIds.includes(request.accountId) || request.scope.sourceTypes.length === 0) {
      return this.persist(request, manifestId, queryHash, scopeHash, [], plan.maxContextCharacters, true);
    }
    const effective = await this.database.sql<{ allowed: boolean }[]>`
      select exists (
        select 1 from opportunities opportunity join permission_grants permission
          on permission.account_id is null or permission.account_id = opportunity.account_id
        where opportunity.id = ${request.opportunityId} and opportunity.account_id = ${request.accountId}
          and permission.persona_id = ${request.scope.personaId} and permission.can_read = true
          and (permission.source_type is null or permission.source_type = any(${request.scope.sourceTypes}::text[]))
          and (opportunity.restricted = false or (permission.can_read_restricted = true and ${request.scope.canViewRestrictedAccounts} = true))
      ) as allowed
    `;
    if (effective[0]?.allowed !== true) return this.persist(request, manifestId, queryHash, scopeHash, [], plan.maxContextCharacters, true);
    const sourceTypes = [...request.scope.sourceTypes];
    const candidateLimit = Math.max(request.limit, request.limit * sourceTypes.length);
    const common = {
      personaId: request.scope.personaId,
      accountId: request.accountId,
      opportunityId: request.opportunityId,
      sourceTypes,
      allowSensitive: request.scope.canViewSensitivePricing,
      allowRestricted: request.scope.canViewRestrictedAccounts,
      sourceLimit: request.limit,
      candidateLimit
    };
    await this.assertIndexReady(common);
    const queryEmbeddings = await this.embeddingGateway.embed([plan.query]);
    const queryEmbedding = queryEmbeddings[0];
    if (queryEmbedding === undefined || queryEmbedding.length !== this.profile.dimension || queryEmbedding.some((value) => !Number.isFinite(value))) {
      throw new Error('Query embedding dimension does not match the active index profile');
    }
    if (queryEmbedding.every((value) => value === 0)) throw new Error('Query embedding must be non-zero');
    const [lexical, semantic, exactContext, mandatoryPolicy] = await Promise.all([
      this.searchLexical(plan.query, common),
      this.searchSemantic(queryEmbedding, common),
      this.searchFixedSource('salesforce', common),
      this.searchFixedSource('policy', common)
    ]);
    const rows = new Map([...lexical, ...semantic, ...mandatoryPolicy].map((row) => [row.id, row]));
    const fused = reciprocalRankFusion([lexical.map((row) => row.id), semantic.map((row) => row.id)], plan.fusionK);
    const ranked = fused.map((entry) => {
      const row = rows.get(entry.id)!;
      const adjustment = applyEvidenceAdjustments({ fusionScore: entry.score, sourceType: row.source_type, reliabilityClass: row.reliability_class, ...(row.event_date === null ? {} : { eventDate: row.event_date }) }, this.now());
      return { row, fusionScore: entry.score, ...adjustment, lexicalRank: lexical.findIndex((candidate) => candidate.id === entry.id) + 1 || undefined, semanticRank: semantic.findIndex((candidate) => candidate.id === entry.id) + 1 || undefined };
    }).sort((left, right) => right.score - left.score || left.row.id.localeCompare(right.row.id));
    const top = ranked.slice(0, request.limit);
    if (!top.some((entry) => entry.row.source_type === 'policy')) {
      const policy = ranked.find((entry) => entry.row.source_type === 'policy');
      if (policy !== undefined) top.splice(Math.max(0, top.length - 1), 1, policy);
    }
    top.sort((left, right) => right.score - left.score || left.row.id.localeCompare(right.row.id));
    const evidence: RetrievedEvidence[] = [];
    let remaining = plan.maxContextCharacters;
    for (let index = 0; index < top.length && remaining > 0; index += 1) {
      const candidate = top[index]!;
      const content = candidate.row.content.slice(0, remaining);
      if (content.length === 0) continue;
      remaining -= content.length;
      evidence.push({
        evidenceId: candidate.row.id,
        citationId: citationId(manifestId, candidate.row.id),
        content,
        contentHash: candidate.row.content_hash,
        sourceType: candidate.row.source_type,
        sensitivity: candidate.row.sensitivity,
        sourceLocator: candidate.row.source_locator,
        classificationReason: candidate.row.classification_reason,
        policyHash: candidate.row.policy_hash,
        ...(candidate.row.event_date === null ? {} : { eventDate: candidate.row.event_date }),
        reliabilityClass: candidate.row.reliability_class,
        ...(candidate.lexicalRank === undefined ? {} : { lexicalRank: candidate.lexicalRank }),
        ...(candidate.semanticRank === undefined ? {} : { semanticRank: candidate.semanticRank }),
        fusionScore: candidate.fusionScore,
        reliabilityAdjustment: candidate.reliabilityAdjustment,
        recencyAdjustment: candidate.recencyAdjustment,
        score: candidate.score,
        rank: evidence.length + 1
      });
    }
    return this.persist(request, manifestId, queryHash, scopeHash, evidence, plan.maxContextCharacters, false, exactContext.length);
  }

  private async searchLexical(query: string, input: QueryScope): Promise<SearchRow[]> {
    return this.database.sql<SearchRow[]>`
      with authorized as (${this.authorizedRows(input)}), ranked as (
        select authorized.*, ts_rank_cd(authorized.lexical_content, websearch_to_tsquery('english', ${query})) as relevance,
          row_number() over (partition by authorized.source_type order by ts_rank_cd(authorized.lexical_content, websearch_to_tsquery('english', ${query})) desc, authorized.id asc) as source_rank
        from authorized where authorized.lexical_content @@ websearch_to_tsquery('english', ${query})
      ) select id, content, content_hash, source_type, sensitivity, event_date::text, reliability_class, source_locator, classification_reason, policy_hash
        from ranked where source_rank <= ${input.sourceLimit} order by relevance desc, id asc limit ${input.candidateLimit}
    `;
  }

  private async assertIndexReady(input: QueryScope): Promise<void> {
    const rows = await this.database.sql<{ total: number; matching: number }[]>`
      with authorized as (${this.authorizedRows(input)})
      select count(*)::integer as total, count(*) filter (where
        embedding is not null and embedding_provider = ${this.profile.provider} and embedding_model = ${this.profile.model}
        and embedding_dimension = ${this.profile.dimension} and embedding_profile = ${this.profile.profile}
        and embedding_version = ${this.profile.version} and embedding_normalization = ${this.profile.normalization}
        and embedding_content_hash = content_hash and vector_dims(embedding) = ${this.profile.dimension}
      )::integer as matching from authorized
    `;
    const health = rows[0];
    if (health !== undefined && health.total !== health.matching) throw new Error('Evidence index is not ready for the active embedding profile');
  }

  private async searchSemantic(embedding: readonly number[], input: QueryScope): Promise<SearchRow[]> {
    return this.database.sql<SearchRow[]>`
      with authorized as (${this.authorizedRows(input)}), ranked as (
        select authorized.*, row_number() over (partition by authorized.source_type order by authorized.embedding <=> ${vectorLiteral(embedding)}::vector, authorized.id asc) as source_rank
        from authorized where authorized.embedding is not null
          and vector_dims(authorized.embedding) = ${this.profile.dimension}
          and authorized.embedding_provider = ${this.profile.provider} and authorized.embedding_model = ${this.profile.model}
          and authorized.embedding_dimension = ${this.profile.dimension} and authorized.embedding_profile = ${this.profile.profile}
          and authorized.embedding_version = ${this.profile.version} and authorized.embedding_normalization = ${this.profile.normalization}
      ) select id, content, content_hash, source_type, sensitivity, event_date::text, reliability_class, source_locator, classification_reason, policy_hash
        from ranked where source_rank <= ${input.sourceLimit} order by embedding <=> ${vectorLiteral(embedding)}::vector, id asc limit ${input.candidateLimit}
    `;
  }

  private async searchFixedSource(sourceType: AuthorizedSourceType, input: QueryScope): Promise<SearchRow[]> {
    if (!input.sourceTypes.includes(sourceType)) return [];
    return this.database.sql<SearchRow[]>`
      with authorized as (${this.authorizedRows(input)})
      select id, content, content_hash, source_type, sensitivity, event_date::text, reliability_class, source_locator, classification_reason, policy_hash
      from authorized where source_type = ${sourceType}
      order by
        case
          when ${sourceType} = 'salesforce' and source_locator like ${`%opportunities.tsv#${input.opportunityId}%`} then 0
          when ${sourceType} = 'salesforce' and source_locator like ${`%accounts.tsv#${input.accountId}%`} then 1
          else 2
        end,
        id asc
      limit ${input.sourceLimit}
    `;
  }

  private authorizedRows(input: QueryScope) {
    return this.database.sql`
      select evidence.* from evidence_versions evidence
      join opportunities opportunity on opportunity.id = evidence.opportunity_id
      where evidence.account_id = ${input.accountId} and evidence.opportunity_id = ${input.opportunityId}
        and evidence.source_type = any(${input.sourceTypes}::text[])
        and (opportunity.restricted = false or ${input.allowRestricted} = true)
        and (evidence.sensitivity <> 'restricted'
          or (evidence.source_type = 'pricing' and ${input.allowSensitive} = true)
          or (evidence.source_type <> 'pricing' and ${input.allowRestricted} = true))
        and exists (
          select 1 from permission_grants permission where permission.persona_id = ${input.personaId}
            and permission.can_read = true and (permission.account_id is null or permission.account_id = evidence.account_id)
            and (permission.source_type is null or permission.source_type = evidence.source_type)
            and (opportunity.restricted = false or permission.can_read_restricted = true)
            and (evidence.sensitivity <> 'restricted'
              or (evidence.source_type = 'pricing' and permission.sensitive_pricing = true)
              or (evidence.source_type <> 'pricing' and permission.can_read_restricted = true))
        )
    `;
  }

  private async persist(request: RetrievalRequest, manifestId: string, queryHash: string, scopeHash: string, evidence: readonly RetrievedEvidence[], maxContextCharacters: number, opaqueNoAccess = false, exactContextAvailable = 0): Promise<RetrievalResult> {
    const policyHashes = [...new Set(evidence.filter((entry) => entry.sourceType === 'policy').map((entry) => entry.policyHash))].sort();
    const policyHash = sha256(policyHashes.join('\u001f'));
    const indexProfile = sha256(stableJson(this.profile));
    await this.database.sql.begin(async (transaction) => {
      await transaction`insert into run_evidence_manifests
        (id, run_id, scope_hash, policy_hash, query_hash, index_profile, embedding_provider, embedding_model, embedding_dimension, embedding_version, embedding_normalization)
        values (${manifestId}, ${request.runId}, ${scopeHash}, ${policyHash}, ${queryHash}, ${indexProfile}, ${this.profile.provider}, ${this.profile.model}, ${this.profile.dimension}, ${this.profile.version}, ${this.profile.normalization})`;
      for (const entry of evidence) await transaction`insert into run_evidence_manifest_entries
        (manifest_id, evidence_version_id, citation_id, rank, query_rank, score, content_hash, source_locator, source_type, sensitivity, classification_reason, policy_hash, lexical_rank, semantic_rank, reliability_adjustment, recency_adjustment)
        values (${manifestId}, ${entry.evidenceId}, ${entry.citationId}, ${entry.rank}, ${entry.rank}, ${entry.score}, ${entry.contentHash}, ${entry.sourceLocator}, ${entry.sourceType}, ${entry.sensitivity}, ${entry.classificationReason}, ${entry.policyHash}, ${entry.lexicalRank ?? null}, ${entry.semanticRank ?? null}, ${entry.reliabilityAdjustment}, ${entry.recencyAdjustment})`;
    });
    const present = new Set(evidence.map((entry) => entry.sourceType));
    const missingSourceTypes = opaqueNoAccess ? [] : request.scope.sourceTypes.filter((sourceType) => !present.has(sourceType));
    return {
      evidence,
      manifest: { id: manifestId, runId: request.runId, queryHash, scopeHash, policyHash, indexProfile },
      diagnostics: { returned: evidence.length, contextCharacters: maxContextCharacters - Math.max(0, maxContextCharacters - evidence.reduce((sum, entry) => sum + entry.content.length, 0)), exactContextAvailable, missingSourceTypes }
    };
  }
}

type QueryScope = Readonly<{
  personaId: string; accountId: string; opportunityId: string; sourceTypes: readonly AuthorizedSourceType[];
  allowSensitive: boolean; allowRestricted: boolean; sourceLimit: number; candidateLimit: number;
}>;

/** Reauthorizes the immutable manifest entry and current row through one opaque lookup. */
export class PostgresCitationResolver implements CitationResolver {
  public constructor(private readonly database: DatabaseClient) {}

  public async resolve(request: CitationResolutionRequest): Promise<AuthorizedCitation> {
    const rows = await this.database.sql<CitationRow[]>`
      select entry.citation_id, evidence.id as evidence_id, evidence.content, evidence.source_type, entry.source_locator
      from run_evidence_manifest_entries entry
      join run_evidence_manifests manifest on manifest.id = entry.manifest_id
      join evidence_versions evidence on evidence.id = entry.evidence_version_id and evidence.content_hash = entry.content_hash
      join opportunities opportunity on opportunity.id = evidence.opportunity_id
      where entry.manifest_id = ${request.manifestId} and entry.citation_id = ${request.citationId}
        and evidence.account_id = any(${request.scope.accountIds}::text[])
        and evidence.source_type = any(${request.scope.sourceTypes}::text[])
        and (opportunity.restricted = false or ${request.scope.canViewRestrictedAccounts} = true)
        and (evidence.sensitivity <> 'restricted'
          or (evidence.source_type = 'pricing' and ${request.scope.canViewSensitivePricing} = true)
          or (evidence.source_type <> 'pricing' and ${request.scope.canViewRestrictedAccounts} = true))
        and exists (
          select 1 from permission_grants permission where permission.persona_id = ${request.scope.personaId}
            and permission.can_read = true and (permission.account_id is null or permission.account_id = evidence.account_id)
            and (permission.source_type is null or permission.source_type = evidence.source_type)
            and (opportunity.restricted = false or permission.can_read_restricted = true)
            and (evidence.sensitivity <> 'restricted'
              or (evidence.source_type = 'pricing' and permission.sensitive_pricing = true)
              or (evidence.source_type <> 'pricing' and permission.can_read_restricted = true))
        ) limit 1
    `;
    const row = rows[0];
    if (row === undefined) throw opaqueCitationDenial();
    return { citationId: row.citation_id as AuthorizedCitation['citationId'], evidenceId: row.evidence_id, content: row.content, sourceType: row.source_type, sourceLocator: row.source_locator };
  }
}
