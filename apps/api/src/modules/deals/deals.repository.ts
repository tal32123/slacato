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
    accountIds: readonly string[],
    restrictedAccountIds: readonly string[],
    salesforceAccountIds: readonly string[],
    restrictedSalesforceAccountIds: readonly string[]
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
          and opportunity.account_id = any(${salesforceAccountIds}::text[])
          and (opportunity.restricted = false or opportunity.account_id = any(${restrictedSalesforceAccountIds}::text[]))
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
    if (scope.sourceTypes.length === 0) return [];
    return this.database.sql<EvidenceRow[]>`
      select evidence.id, evidence.source_type, evidence.sensitivity, evidence.event_date::text,
        evidence.source_locator, evidence.content, evidence.created_at
      from evidence_versions evidence
      where evidence.opportunity_id = ${scope.opportunityId}
        and evidence.account_id = ${scope.accountId}
        and evidence.source_type = any(${scope.sourceTypes}::text[])
        and (
          evidence.sensitivity <> 'restricted'
          or (evidence.source_type = 'pricing' and ${scope.canViewSensitivePricing} = true)
          or (evidence.source_type <> 'pricing' and ${scope.canViewRestrictedEvidence} = true)
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
