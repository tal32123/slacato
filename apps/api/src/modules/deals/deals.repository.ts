import { CANONICAL_FIXTURE_COMMIT, dealBriefSchema, runStatusSchema } from '@slacato/core';
import type { DatabaseClient } from '@slacato/infrastructure';
import type {
  AuthorizedDeal,
  DealEvidence,
  DealQueryRepository,
  EvidenceCategory,
  EvidenceScope,
  LatestDealRun
} from './contracts.js';

type AuthorizedDealSqlRow = Readonly<{
  opportunity_id: string;
  opportunity_name: string;
  account_id: string;
  account_name: string;
  restricted: boolean;
  created_at: Date | string;
  record_content: string | null;
  latest_run_status: string | null;
  latest_run_updated_at: Date | string | null;
}>;

type LatestDealRunSqlRow = Readonly<{
  id: string;
  status: string;
  updated_at: Date | string;
  generated_output_lifecycle: 'draft' | 'finalized' | null;
  generated_output_payload: unknown | null;
}>;

type DealEvidenceSqlRow = Readonly<{
  id: string;
  source_type: string;
  sensitivity: string;
  event_date: string | null;
  source_locator: string | null;
  content: string;
  created_at: Date | string;
}>;

/** Accepts both native jsonb objects and legacy jsonb string scalars written by older callers. */
function parseStoredDealBrief(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const parsed: unknown = JSON.parse(value);
  return parsed;
}

/** Converts an authorized SQL projection into the camelCase deal query model. */
function mapAuthorizedDealSqlRow(row: AuthorizedDealSqlRow): AuthorizedDeal {
  const latestRun =
    row.latest_run_status === null || row.latest_run_updated_at === null
      ? null
      : {
          status: runStatusSchema.parse(row.latest_run_status),
          updatedAt: row.latest_run_updated_at
        };
  return {
    opportunityId: row.opportunity_id,
    opportunityName: row.opportunity_name,
    accountId: row.account_id,
    accountName: row.account_name,
    restricted: row.restricted,
    createdAt: row.created_at,
    recordContent: row.record_content,
    latestRun
  };
}

/** Converts the latest authorized run projection and validates any generated canonical payload. */
function mapLatestDealRunSqlRow(row: LatestDealRunSqlRow): LatestDealRun {
  return {
    runId: row.id,
    status: runStatusSchema.parse(row.status),
    updatedAt: row.updated_at,
    generatedOutput:
      row.generated_output_lifecycle === null || row.generated_output_payload === null
        ? null
        : {
            lifecycle: row.generated_output_lifecycle,
            brief: dealBriefSchema.parse(parseStoredDealBrief(row.generated_output_payload))
          }
  };
}

/** Converts an authorized SQL evidence projection into the camelCase evidence query model. */
function mapDealEvidenceSqlRow(row: DealEvidenceSqlRow): DealEvidence {
  return {
    id: row.id,
    sourceType: row.source_type,
    sensitivity: row.sensitivity,
    eventDate: row.event_date,
    sourceLocator: row.source_locator,
    content: row.content,
    createdAt: row.created_at
  };
}

/** Reads deal workspaces only through live persona-scoped source grants and returns application models. */
export class PostgresDealQueryRepository implements DealQueryRepository {
  /** Creates a deal query repository backed by the provided database client. */
  public constructor(private readonly database: DatabaseClient) {}

  /** Lists deals whose account metadata is currently readable through a Salesforce source grant. */
  public async listAuthorizedDeals(personaId: string): Promise<readonly AuthorizedDeal[]> {
    const rows = await this.database.sql<AuthorizedDealSqlRow[]>`
      select opportunity.id as opportunity_id, opportunity.name as opportunity_name,
        opportunity.account_id, account.name as account_name, opportunity.restricted,
        opportunity.created_at, opportunity_record.content as record_content,
        latest_run.status as latest_run_status, latest_run.updated_at as latest_run_updated_at
      from opportunities opportunity
      join accounts account on account.id = opportunity.account_id
      left join lateral (
        select evidence.content from evidence_versions evidence
        where evidence.opportunity_id = opportunity.id
          and evidence.source_type = 'salesforce'
          and evidence.source_locator like 'salesforce/opportunities.tsv#%'
          and exists (
            select 1 from authorized_evidence_grants evidence_grant
            where evidence_grant.persona_id = ${personaId}
              and evidence_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
              and evidence_grant.evidence_id = evidence.id
              and evidence_grant.opportunity_id = opportunity.id
              and evidence_grant.account_id = opportunity.account_id
              and evidence_grant.source_type = 'salesforce'
          )
        order by evidence.id limit 1
      ) opportunity_record on true
      left join lateral (
        select run.status, run.updated_at from runs run
        where run.opportunity_id = opportunity.id
        order by run.updated_at desc, run.id desc limit 1
      ) latest_run on true
      where exists (
        select 1 from authorized_opportunity_grants opportunity_grant
        where opportunity_grant.persona_id = ${personaId}
          and opportunity_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
          and opportunity_grant.opportunity_id = opportunity.id
          and opportunity_grant.account_id = opportunity.account_id
          and opportunity_grant.source_type = 'salesforce'
      )
      order by opportunity.id
    `;
    return rows.map(mapAuthorizedDealSqlRow);
  }

  /** Finds one deal only when a live Salesforce source grant authorizes its metadata. */
  public async findAuthorizedDeal(
    personaId: string,
    opportunityId: string
  ): Promise<AuthorizedDeal | undefined> {
    const rows = await this.database.sql<AuthorizedDealSqlRow[]>`
      select opportunity.id as opportunity_id, opportunity.name as opportunity_name,
        opportunity.account_id, account.name as account_name, opportunity.restricted,
        opportunity.created_at, null::text as record_content,
        null::text as latest_run_status, null::timestamptz as latest_run_updated_at
      from opportunities opportunity
      join accounts account on account.id = opportunity.account_id
      where opportunity.id = ${opportunityId}
        and exists (
          select 1 from authorized_opportunity_grants opportunity_grant
          where opportunity_grant.persona_id = ${personaId}
            and opportunity_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
            and opportunity_grant.opportunity_id = opportunity.id
            and opportunity_grant.account_id = opportunity.account_id
            and opportunity_grant.source_type = 'salesforce'
        )
      limit 1
    `;
    return rows[0] === undefined ? undefined : mapAuthorizedDealSqlRow(rows[0]);
  }

  /** Loads the latest run and any generated draft or finalized payload while its deal remains authorized. */
  public async findLatestRun(
    personaId: string,
    opportunityId: string
  ): Promise<LatestDealRun | undefined> {
    const rows = await this.database.sql<LatestDealRunSqlRow[]>`
      select run.id, run.status, run.updated_at,
        case when finalized_brief.payload is not null then 'finalized'
          when generated_draft.payload is not null then 'draft' else null end as generated_output_lifecycle,
        coalesce(finalized_brief.payload, generated_draft.payload) as generated_output_payload
      from runs run
      join opportunities opportunity on opportunity.id = run.opportunity_id
      left join lateral (
        select brief.payload
        from briefs brief
        where brief.run_id = run.id
          and brief.finalized_at is not null
        order by brief.draft_version desc
        limit 1
      ) finalized_brief on true
      left join lateral (
        select subject.payload
        from approval_subjects subject
        where subject.run_id = run.id
          and subject.payload is not null
        order by subject.draft_version desc, subject.created_at desc
        limit 1
      ) generated_draft on true
      where run.opportunity_id = ${opportunityId}
        and exists (
          select 1 from authorized_opportunity_grants opportunity_grant
          where opportunity_grant.persona_id = ${personaId}
            and opportunity_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
            and opportunity_grant.opportunity_id = opportunity.id
            and opportunity_grant.account_id = opportunity.account_id
            and opportunity_grant.source_type = 'salesforce'
        )
      order by run.updated_at desc, run.id desc
      limit 1
    `;
    return rows[0] === undefined ? undefined : mapLatestDealRunSqlRow(rows[0]);
  }

  /** Lists evidence whose source-specific live grant authorizes the requested workspace category. */
  public async listEvidence(
    scope: EvidenceScope,
    category: EvidenceCategory
  ): Promise<readonly DealEvidence[]> {
    const rows = await this.database.sql<DealEvidenceSqlRow[]>`
      select evidence.id, evidence.source_type, evidence.sensitivity, evidence.event_date::text,
        evidence.source_locator, evidence.content, evidence.created_at
      from evidence_versions evidence
      where evidence.opportunity_id = ${scope.opportunityId}
        and evidence.account_id = ${scope.accountId}
        and evidence.source_locator is not null
        and btrim(evidence.source_locator) <> ''
        and exists (
          select 1 from authorized_evidence_grants evidence_grant
          where evidence_grant.persona_id = ${scope.personaId}
            and evidence_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
            and evidence_grant.evidence_id = evidence.id
            and evidence_grant.opportunity_id = ${scope.opportunityId}
            and evidence_grant.account_id = ${scope.accountId}
            and evidence_grant.source_type = evidence.source_type
        )
        and (
          (${category} = 'opportunity' and evidence.source_type = 'salesforce' and evidence.source_locator like 'salesforce/opportunities.tsv#%')
          or (${category} = 'stakeholders' and evidence.source_type = 'salesforce' and evidence.source_locator like 'salesforce/contacts.tsv#%')
          or (${category} = 'supplemental' and not (
            evidence.source_type = 'salesforce'
            and (evidence.source_locator like 'salesforce/opportunities.tsv#%' or evidence.source_locator like 'salesforce/contacts.tsv#%')
          ))
        )
      order by evidence.event_date desc nulls last, evidence.source_type, evidence.id
    `;
    return rows.map(mapDealEvidenceSqlRow);
  }
}
