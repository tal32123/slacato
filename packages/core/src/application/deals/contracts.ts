import type { DealBrief } from '../../domain/briefs/schema.js';
import type { PermissionGrant } from '../../domain/permissions/authorize.js';
import type { RunStatus } from '../../domain/runs/contracts.js';

/** Authenticated session context used to authorize deal queries. */
export type DealQuerySession = Readonly<{
  claims: Readonly<{ version: string }>;
  persona: Readonly<{
    userId: string;
    displayName: string;
    role: string;
    grants: readonly PermissionGrant[];
  }>;
}>;

/** Summarizes the current status and update time of a deal run. */
export type DealRunSummary = Readonly<{
  status: RunStatus;
  updatedAt: Date | string;
}>;

/** Represents a deal workspace visible to the requesting persona. */
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

/** Carries a generated deal brief and its draft or finalized lifecycle. */
export type GeneratedDealOutput = Readonly<{
  lifecycle: 'draft' | 'finalized';
  brief: DealBrief;
}>;

/** Describes the latest authorized run and any generated output. */
export type LatestDealRun = DealRunSummary &
  Readonly<{
    runId: string;
    generatedOutput: GeneratedDealOutput | null;
  }>;

/** Represents one authorized evidence record displayed in a deal workspace. */
export type DealEvidence = Readonly<{
  id: string;
  sourceType: string;
  sensitivity: string;
  eventDate: string | null;
  sourceLocator: string | null;
  content: string;
  createdAt: Date | string;
}>;

/** Identifies the deal workspace section used to group evidence. */
export type EvidenceCategory = 'opportunity' | 'stakeholders' | 'supplemental';

/** Defines the persona and Salesforce records used to authorize evidence access. */
export type EvidenceScope = Readonly<{
  personaId: string;
  opportunityId: string;
  accountId: string;
  restrictedOpportunity: boolean;
}>;

/** Supplies persona-authorized deal workspaces, runs, and evidence to query handlers. */
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
