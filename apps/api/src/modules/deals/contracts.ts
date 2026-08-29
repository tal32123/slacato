import type { DealBrief, PermissionGrant, RunStatus } from '@slacato/core';

export const DEALS_OPTIONS = Symbol('DEALS_OPTIONS');

export type DealQuerySession = Readonly<{
  claims: Readonly<{ version: string }>;
  persona: Readonly<{ userId: string; displayName: string; role: string; grants: readonly PermissionGrant[] }>;
}>;

export type DealRunSummary = Readonly<{
  status: RunStatus;
  updatedAt: Date | string;
}>;

export type AuthorizedDeal = Readonly<{
  opportunityId: string;
  opportunityName: string;
  accountId: string;
  accountName: string;
  restricted: boolean;
  createdAt: Date | string;
  recordContent: string | null;
  latestRun: DealRunSummary | null;
}>;

export type GeneratedDealOutput = Readonly<{
  lifecycle: 'draft' | 'finalized';
  brief: DealBrief;
}>;

export type LatestDealRun = DealRunSummary & Readonly<{
  runId: string;
  generatedOutput: GeneratedDealOutput | null;
}>;

export type DealEvidence = Readonly<{
  id: string;
  sourceType: string;
  sensitivity: string;
  eventDate: string | null;
  sourceLocator: string | null;
  content: string;
  createdAt: Date | string;
}>;

export type EvidenceCategory = 'opportunity' | 'stakeholders' | 'supplemental';

export type EvidenceScope = Readonly<{
  personaId: string;
  opportunityId: string;
  accountId: string;
  restrictedOpportunity: boolean;
}>;

export interface DealQueryRepository {
  /** Lists deals authorized by a live Salesforce source grant for the persona. */
  listAuthorizedDeals(personaId: string): Promise<readonly AuthorizedDeal[]>;
  /** Finds one deal authorized by a live Salesforce source grant for the persona. */
  findAuthorizedDeal(personaId: string, opportunityId: string): Promise<AuthorizedDeal | undefined>;
  /** Finds the latest authorized run and its generated draft or finalized output, when present. */
  findLatestRun(personaId: string, opportunityId: string): Promise<LatestDealRun | undefined>;
  /** Lists source-specific authorized evidence for one deal workspace category. */
  listEvidence(scope: EvidenceScope, category: EvidenceCategory): Promise<readonly DealEvidence[]>;
}

export type DealsModuleOptions = Readonly<{ repository: DealQueryRepository }>;
