import type { PermissionGrant } from '@slacato/core';

export const DEALS_OPTIONS = Symbol('DEALS_OPTIONS');

export type DealQuerySession = Readonly<{
  claims: Readonly<{ version: string }>;
  persona: Readonly<{ userId: string; displayName: string; role: string; grants: readonly PermissionGrant[] }>;
}>;

export type AuthorizedDealRow = Readonly<{
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

export type LatestRunRow = Readonly<{ status: string; updated_at: Date | string }>;

export type EvidenceRow = Readonly<{
  id: string;
  source_type: string;
  sensitivity: string;
  event_date: string | null;
  source_locator: string | null;
  content: string;
  created_at: Date | string;
}>;

export type EvidenceCategory = 'opportunity' | 'stakeholders' | 'supplemental';

export type EvidenceScope = Readonly<{
  personaId: string;
  opportunityId: string;
  accountId: string;
}>;

export interface DealQueryRepository {
  listAuthorizedDeals(
    personaId: string,
    accountIds: readonly string[],
    restrictedAccountIds: readonly string[]
  ): Promise<readonly AuthorizedDealRow[]>;
  findAuthorizedDeal(opportunityId: string, accountIds: readonly string[], restrictedAccountIds: readonly string[]): Promise<AuthorizedDealRow | undefined>;
  findLatestRun(opportunityId: string): Promise<LatestRunRow | undefined>;
  listEvidence(scope: EvidenceScope, category: EvidenceCategory): Promise<readonly EvidenceRow[]>;
}

export type DealsModuleOptions = Readonly<{ repository: DealQueryRepository }>;
