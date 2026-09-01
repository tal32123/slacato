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

/** Identifies the actor-authorized actionable approval subject without exposing approval details. */
export type ApprovalReviewDescriptor = Readonly<{
  approvalSubjectId: string;
}>;

/** Describes the latest authorized run, any generated output, and its actionable approval review. */
export type LatestDealRun = DealRunSummary &
  Readonly<{
    runId: string;
    generatedOutput: GeneratedDealOutput | null;
    approvalReview: ApprovalReviewDescriptor | null;
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

/** Describes one refused request in terms that identify the actor but never the target. */
export type OpaqueDenialEvent = Readonly<{
  /** Identifies the persona whose request was refused. */
  actorId: string;
  /** States why the request was refused, in terms that describe no protected record. */
  reason: 'forbidden';
}>;

/**
 * Records that a request was refused, without recording what it was refused access to.
 *
 * A denial audit exists to prove the refusal happened, not to describe the protected record. The
 * event therefore carries only the actor and an opaque reason: no account, opportunity, source, or
 * count, and no signal distinguishing "exists but forbidden" from "does not exist". Implementations
 * must keep that property, because the audit trail outlives the request that produced it.
 */
export interface OpaqueDenialRecorder {
  /** Appends one non-disclosing audit record for a refused request. */
  recordOpaqueDenial(event: OpaqueDenialEvent): Promise<void>;
}

/** Supplies persona-authorized deal workspaces, runs, and evidence to query handlers. */
export interface DealQueryRepository {
  /** Lists deals authorized by a live Salesforce source grant for the persona. */
  listAuthorizedDeals(personaId: string): Promise<readonly AuthorizedDeal[]>;
  /** Finds one deal authorized by a live Salesforce source grant for the persona. */
  findAuthorizedDeal(personaId: string, opportunityId: string): Promise<AuthorizedDeal | undefined>;
  /** Finds the latest authorized run, generated output, and actor-authorized actionable approval subject. */
  findLatestRun(personaId: string, opportunityId: string): Promise<LatestDealRun | undefined>;
  /** Lists source-specific authorized evidence for one deal workspace category. */
  listEvidence(scope: EvidenceScope, category: EvidenceCategory): Promise<readonly DealEvidence[]>;
}
