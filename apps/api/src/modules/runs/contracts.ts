import type {
  ApprovalDetailResponse,
  ApprovalInboxResponse,
  RunDetailResponse,
  RunListResponse
} from '@slacato/contracts';
import type { CancelDealBrief, DecideApproval, RegenerateDealBrief, RunEventBus, RunEventQuery, StartDealBrief } from '@slacato/core';

export const START_DEAL_BRIEF = Symbol('START_DEAL_BRIEF');
export const REGENERATE_DEAL_BRIEF = Symbol('REGENERATE_DEAL_BRIEF');
export const CANCEL_DEAL_BRIEF = Symbol('CANCEL_DEAL_BRIEF');
export const DECIDE_APPROVAL = Symbol('DECIDE_APPROVAL');
export const RUN_EVENT_BUS = Symbol('RUN_EVENT_BUS');
export const RUN_EVENT_QUERY = Symbol('RUN_EVENT_QUERY');
export const RUN_EVENT_HEARTBEAT_MS = Symbol('RUN_EVENT_HEARTBEAT_MS');
export const RUN_QUERIES = Symbol('RUN_QUERIES');
export const APPROVAL_QUERIES = Symbol('APPROVAL_QUERIES');

/** Supplies actor-scoped read models for the run query endpoints. */
export interface RunQueryRepository {
  /** Lists runs visible to the actor under the supplied session version. */
  listRuns(actorId: string, sessionVersion: string): Promise<RunListResponse>;
  /** Returns one visible run, or no result when it is absent or opaque to the actor. */
  getRun(actorId: string, sessionVersion: string, runId: string): Promise<RunDetailResponse | undefined>;
}

/** Supplies actor-scoped read models for the approval query endpoints. */
export interface ApprovalQueryRepository {
  /** Lists approvals visible to the actor under the supplied session version. */
  listApprovals(actorId: string, sessionVersion: string): Promise<ApprovalInboxResponse>;
  /** Returns one visible approval, or no result when it is absent or opaque to the actor. */
  getApproval(actorId: string, sessionVersion: string, subjectId: string): Promise<ApprovalDetailResponse | undefined>;
}

export type WorkflowApiOptions = Readonly<{
  startDealBrief: StartDealBrief;
  regenerateDealBrief: RegenerateDealBrief;
  cancelDealBrief: CancelDealBrief;
  runQueries?: RunQueryRepository | undefined;
  approvalQueries?: ApprovalQueryRepository | undefined;
  runEvents?: Readonly<{
    bus: RunEventBus;
    query: RunEventQuery;
    heartbeatMs?: number;
  }> | undefined;
  decideApproval: DecideApproval;
}>;

