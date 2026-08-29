import { CANONICAL_FIXTURE_COMMIT } from '@slacato/core';
import type { DatabaseClient } from '@slacato/infrastructure';
import type {
  AuthorizedDealRow,
  DealQueryRepository,
  EvidenceCategory,
  EvidenceRow,
  EvidenceScope,
  LatestRunRow
} from './contracts.js';

export class PostgresDealQueryRepository implements DealQueryRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async listAuthorizedDeals(
    personaId: string,
    accountIds: readonly string[],
    restrictedAccountIds: readonly string[]
  ): Promise<readonly AuthorizedDealRow[]> {
    if (accountIds.length === 0) return [];
    return this.database.sql<AuthorizedDealRow[]>`
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
            select 1 from permission_grants source_grant
            where source_grant.persona_id = ${personaId}
              and source_grant.account_id = opportunity.account_id
              and source_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
              and source_grant.source_type = 'salesforce'
              and source_grant.can_read = true
              and (evidence.sensitivity <> 'restricted' or source_grant.can_read_restricted = true)
              and (opportunity.restricted = false or source_grant.can_read_restricted = true)
          )
        order by evidence.id limit 1
      ) opportunity_record on true
      left join lateral (
        select run.status, run.updated_at from runs run
        where run.opportunity_id = opportunity.id
        order by run.updated_at desc, run.id desc limit 1
      ) latest_run on true
      where opportunity.account_id = any(${accountIds}::text[])
        and (opportunity.restricted = false or opportunity.account_id = any(${restrictedAccountIds}::text[]))
      order by opportunity.id
    `;
  }

  public async findAuthorizedDeal(
    opportunityId: string,
    accountIds: readonly string[],
    restrictedAccountIds: readonly string[]
  ): Promise<AuthorizedDealRow | undefined> {
    if (accountIds.length === 0) return undefined;
    const rows = await this.database.sql<AuthorizedDealRow[]>`
      select opportunity.id as opportunity_id, opportunity.name as opportunity_name,
        opportunity.account_id, account.name as account_name, opportunity.restricted,
        opportunity.created_at, null::text as record_content,
        null::text as latest_run_status, null::timestamptz as latest_run_updated_at
      from opportunities opportunity
      join accounts account on account.id = opportunity.account_id
      where opportunity.id = ${opportunityId}
        and opportunity.account_id = any(${accountIds}::text[])
        and (opportunity.restricted = false or opportunity.account_id = any(${restrictedAccountIds}::text[]))
      limit 1
    `;
    return rows[0];
  }

  public async findLatestRun(opportunityId: string): Promise<LatestRunRow | undefined> {
    const rows = await this.database.sql<LatestRunRow[]>`
      select status, updated_at from runs where opportunity_id = ${opportunityId}
      order by updated_at desc, id desc limit 1
    `;
    return rows[0];
  }

  public async listEvidence(scope: EvidenceScope, category: EvidenceCategory): Promise<readonly EvidenceRow[]> {
    return this.database.sql<EvidenceRow[]>`
      select evidence.id, evidence.source_type, evidence.sensitivity, evidence.event_date::text,
        evidence.source_locator, evidence.content, evidence.created_at
      from evidence_versions evidence
      where evidence.opportunity_id = ${scope.opportunityId}
        and evidence.account_id = ${scope.accountId}
        and evidence.source_locator is not null
        and btrim(evidence.source_locator) <> ''
        and exists (
          select 1 from permission_grants source_grant
          where source_grant.persona_id = ${scope.personaId}
            and source_grant.account_id = evidence.account_id
            and source_grant.source_type = evidence.source_type
            and source_grant.can_read = true
            and source_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
            and (${scope.restrictedOpportunity} = false or source_grant.can_read_restricted = true)
            and (
              evidence.sensitivity <> 'restricted'
              or (evidence.source_type = 'pricing' and source_grant.sensitive_pricing = true)
              or (evidence.source_type <> 'pricing' and source_grant.can_read_restricted = true)
            )
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
  }
}
