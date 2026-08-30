import {
  type AgentManifestEntry,
  CANONICAL_FIXTURE_COMMIT,
  type EmbeddingGateway,
  type EmbeddingProfile,
  MAX_SHORT_TEXT_LENGTH,
  type PermissionGrant,
  type RetrievalRequest,
  type RetrievalResult,
  type RunBudgetLimits
} from '@slacato/core';
import type { DatabaseClient } from '../db/client.js';
import { PostgresHybridEvidenceRetriever } from '../retrieval/postgres-retriever.js';

type OpportunityContextRow = Readonly<{
  account_id: string;
  account_name: string;
  opportunity_name: string;
  restricted: boolean;
  stage_evidence_id: string;
  stage_evidence_content: string;
}>;

type GrantRow = Readonly<{
  accountId: string;
  source_type: PermissionGrant['sourceType'];
  canRead: boolean;
  canReadRestricted: boolean;
  canRequestApproval: boolean;
  canApprove: boolean;
  sensitivePricing: boolean;
}>;

type EmbeddingProfileRow = Readonly<{
  provider: string;
  model: string;
  dimension: number;
  profile: string;
  version: string;
  normalization: string;
}>;

type BudgetRow = Readonly<{
  max_calls: number;
  deadline_ms: number;
}>;

type ManifestEntryRow = Readonly<{
  citation_id: string;
  evidence_version_id: string;
  content_hash: string;
  source_locator: string;
  source_type: string;
  sensitivity: string;
  policy_hash: string;
  included_characters: number;
}>;

export type DealBriefOpportunityContext = Readonly<{
  accountId: string;
  accountName: string;
  opportunityName: string;
  restricted: boolean;
  stage: string;
  stageEvidenceId: string;
}>;

/** Reads and validates the stage field from a persisted canonical Salesforce opportunity record. */
function readCanonicalOpportunityStage(content: string): string {
  const stages = content
    .split('\n')
    .map((line) => {
      const separator = line.indexOf(':');
      if (separator <= 0 || line.slice(0, separator).trim() !== 'stage') return undefined;
      return line.slice(separator + 1).trim();
    })
    .filter((stage): stage is string => stage !== undefined);

  const stage = stages[0];
  if (
    stage === undefined ||
    stages.length !== 1 ||
    stage.length === 0 ||
    stage.length > MAX_SHORT_TEXT_LENGTH
  ) {
    throw new Error('Canonical Salesforce opportunity stage is unavailable');
  }
  return stage;
}

/** Defines the typed data-access operations used by the deal-brief workflow adapter. */
export interface DealBriefContextRepository {
  /** Finds a readable canonical Salesforce opportunity for the persona. */
  findAuthorizedOpportunity(
    personaId: string,
    opportunityId: string
  ): Promise<DealBriefOpportunityContext | undefined>;
  /** Reads the persona's canonical permission grants for an account. */
  readPermissionGrants(personaId: string, accountId: string): Promise<readonly PermissionGrant[]>;
  /** Finds the newest indexed embedding profile for a provider and model. */
  findEmbeddingProfile(
    accountId: string,
    provider: string,
    model: string
  ): Promise<EmbeddingProfile | undefined>;
  /** Reads the durable model-call budget for a workflow run. */
  readRunBudget(runId: string): Promise<RunBudgetLimits>;
  /** Retrieves authorized evidence with the supplied embedding gateway and profile. */
  retrieveEvidence(
    request: RetrievalRequest,
    embeddingGateway: EmbeddingGateway,
    profile: EmbeddingProfile
  ): Promise<RetrievalResult>;
  /** Checks whether a persisted manifest exactly matches the expected context entries. */
  manifestMatches(
    manifestId: string,
    expectedEntries: readonly AgentManifestEntry[]
  ): Promise<boolean>;
}

/** Provides the PostgreSQL reads and retrieval adapter needed to build and revalidate deal-brief context. */
export class PostgresDealBriefContextRepository implements DealBriefContextRepository {
  /** Creates a context repository backed by the worker database connection. */
  public constructor(private readonly database: DatabaseClient) {}

  /** Loads one opportunity only when its canonical Salesforce record is currently readable by the persona. */
  public async findAuthorizedOpportunity(
    personaId: string,
    opportunityId: string
  ): Promise<DealBriefOpportunityContext | undefined> {
    const rows = await this.database.sql<OpportunityContextRow[]>`
      select opportunity.account_id, account.name as account_name,
        opportunity.name as opportunity_name, opportunity.restricted,
        stage_evidence.id as stage_evidence_id,
        stage_evidence.content as stage_evidence_content
      from opportunities opportunity
      join authorized_opportunity_grants opportunity_grant
        on opportunity_grant.opportunity_id = opportunity.id
        and opportunity_grant.account_id = opportunity.account_id
        and opportunity_grant.persona_id = ${personaId}
        and opportunity_grant.source_type = 'salesforce'
        and opportunity_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
      join accounts account on account.id = opportunity.account_id
      join lateral (
        select evidence.id, evidence.content
        from evidence_versions evidence
        join authorized_evidence_grants evidence_grant
          on evidence_grant.evidence_id = evidence.id
          and evidence_grant.opportunity_id = opportunity.id
          and evidence_grant.account_id = opportunity.account_id
          and evidence_grant.persona_id = ${personaId}
          and evidence_grant.source_type = 'salesforce'
          and evidence_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
        where evidence.account_id = opportunity.account_id
          and evidence.opportunity_id = opportunity.id
          and evidence.source_type = 'salesforce'
          and evidence.chunk_index = 0
          and evidence.reliability_class = 'authoritative_system'
          and evidence.source_locator like ${`salesforce/opportunities.tsv#${opportunityId}%`}
        order by evidence.created_at desc, evidence.id desc
        limit 1
      ) stage_evidence on true
      where opportunity.id = ${opportunityId}
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      accountId: row.account_id,
      accountName: row.account_name,
      opportunityName: row.opportunity_name,
      restricted: row.restricted,
      stage: readCanonicalOpportunityStage(row.stage_evidence_content),
      stageEvidenceId: row.stage_evidence_id
    };
  }

  /** Loads the persona's current canonical permission grants for one account. */
  public async readPermissionGrants(
    personaId: string,
    accountId: string
  ): Promise<readonly PermissionGrant[]> {
    const rows = await this.database.sql<GrantRow[]>`
      select account_id "accountId", source_type,
        can_read "canRead", can_read_restricted "canReadRestricted",
        can_request_approval "canRequestApproval", can_approve "canApprove",
        sensitive_pricing "sensitivePricing"
      from permission_grants
      where persona_id = ${personaId}
        and account_id = ${accountId}
        and source_commit = ${CANONICAL_FIXTURE_COMMIT}
    `;
    return rows.map(({ source_type, ...grant }) => ({ ...grant, sourceType: source_type }));
  }

  /** Finds the newest indexed embedding profile matching the configured provider and model. */
  public async findEmbeddingProfile(
    accountId: string,
    provider: string,
    model: string
  ): Promise<EmbeddingProfile | undefined> {
    const rows = await this.database.sql<EmbeddingProfileRow[]>`
      select embedding_provider as provider, embedding_model as model,
        embedding_dimension as dimension, embedding_profile as profile,
        embedding_version as version, embedding_normalization as normalization
      from evidence_versions
      where embedding is not null
        and account_id = ${accountId}
        and embedding_provider = ${provider}
        and embedding_model = ${model}
      order by created_at desc
      limit 1
    `;
    return rows[0];
  }

  /** Loads the durable model-call budget for one workflow run. */
  public async readRunBudget(runId: string): Promise<RunBudgetLimits> {
    const rows = await this.database.sql<BudgetRow[]>`
      select max_calls, deadline_ms
      from run_budgets
      where run_id = ${runId}
    `;
    const budget = rows[0];
    if (budget === undefined) throw new Error('Run budget is unavailable');
    return { scope: runId, maxCalls: budget.max_calls, deadlineMs: budget.deadline_ms };
  }

  /** Runs the authorized PostgreSQL hybrid retriever with the supplied run-scoped embedding gateway. */
  public async retrieveEvidence(
    request: RetrievalRequest,
    embeddingGateway: EmbeddingGateway,
    profile: EmbeddingProfile
  ): Promise<RetrievalResult> {
    return new PostgresHybridEvidenceRetriever(this.database, embeddingGateway, profile).search(
      request
    );
  }

  /** Confirms that persisted manifest entries exactly match the durable generation context fingerprints. */
  public async manifestMatches(
    manifestId: string,
    expectedEntries: readonly AgentManifestEntry[]
  ): Promise<boolean> {
    const rows = await this.database.sql<ManifestEntryRow[]>`
      select citation_id, evidence_version_id, content_hash, source_locator,
        source_type, sensitivity, policy_hash, included_characters
      from run_evidence_manifest_entries
      where manifest_id = ${manifestId}
    `;
    if (rows.length !== expectedEntries.length) return false;

    const expectedByEvidenceId = new Map(expectedEntries.map((entry) => [entry.evidenceId, entry]));
    return rows.every((row) => {
      const expected = expectedByEvidenceId.get(row.evidence_version_id);
      return (
        expected !== undefined &&
        row.citation_id === expected.citationId &&
        row.content_hash === expected.contentHash &&
        row.source_locator === expected.sourceLocator &&
        row.source_type === expected.sourceType &&
        row.sensitivity === expected.sensitivity &&
        row.policy_hash === expected.policyHash &&
        row.included_characters === expected.includedCharacters
      );
    });
  }
}
