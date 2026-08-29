import type {
  ApprovalDetailResponse,
  ApprovalInboxResponse,
  RunDetailResponse,
  RunListResponse
} from '@slacato/contracts';
import type {
  CancelDealBrief,
  DecideApproval,
  RegenerateDealBrief,
  RunEventBus,
  RunEventQuery,
  StartDealBrief
} from '@slacato/core';

/** Injection token for the deal-brief start command. */
export const START_DEAL_BRIEF = Symbol('START_DEAL_BRIEF');
/** Injection token for the deal-brief regeneration command. */
export const REGENERATE_DEAL_BRIEF = Symbol('REGENERATE_DEAL_BRIEF');
/** Injection token for the deal-brief cancellation command. */
export const CANCEL_DEAL_BRIEF = Symbol('CANCEL_DEAL_BRIEF');
/** Injection token for the approval decision command. */
export const DECIDE_APPROVAL = Symbol('DECIDE_APPROVAL');
/** Injection token for the live run-event bus. */
export const RUN_EVENT_BUS = Symbol('RUN_EVENT_BUS');
/** Injection token for authorized run-event snapshots. */
export const RUN_EVENT_QUERY = Symbol('RUN_EVENT_QUERY');
/** Injection token for the run-event stream heartbeat interval. */
export const RUN_EVENT_HEARTBEAT_MS = Symbol('RUN_EVENT_HEARTBEAT_MS');
/** Injection token for actor-scoped run queries. */
export const RUN_QUERIES = Symbol('RUN_QUERIES');
/** Injection token for actor-scoped approval queries. */
export const APPROVAL_QUERIES = Symbol('APPROVAL_QUERIES');
/** Identifies the actor and session used to authorize a query. */
export type QueryPrincipal = Readonly<{ actorId: string; sessionVersion: string }>;

/** Supplies actor-scoped run read models. */
export interface RunQueryRepository {
  /** Lists runs visible to the supplied query principal. */
  listRuns(principal: QueryPrincipal): Promise<RunListResponse>;
  /** Returns one visible run, or no result when it is absent or opaque to the query principal. */
  getRun(principal: QueryPrincipal, runId: string): Promise<RunDetailResponse | undefined>;
}

/** Supplies actor-scoped approval read models. */
export interface ApprovalQueryRepository {
  /** Lists approvals visible to the supplied query principal. */
  listApprovals(principal: QueryPrincipal): Promise<ApprovalInboxResponse>;
  /** Returns one visible approval, or no result when it is absent or opaque to the query principal. */
  getApproval(
    principal: QueryPrincipal,
    subjectId: string
  ): Promise<ApprovalDetailResponse | undefined>;
}

/** Configures workflow API modules with their command, query, and event dependencies. */
export type WorkflowApiOptions = Readonly<{
  /** Handles requests to start deal-brief runs. */
  startDealBrief: StartDealBrief;
  /** Handles requests to regenerate deal-brief runs. */
  regenerateDealBrief: RegenerateDealBrief;
  /** Handles requests to cancel deal-brief runs. */
  cancelDealBrief: CancelDealBrief;
  /** Provides actor-scoped run read models when run queries are enabled. */
  runQueries?: RunQueryRepository | undefined;
  /** Provides actor-scoped approval read models when approval queries are enabled. */
  approvalQueries?: ApprovalQueryRepository | undefined;
  /** Configures live run-event streaming when it is enabled. */
  runEvents?:
    | Readonly<{
        /** Publishes and subscribes to live run events. */
        bus: RunEventBus;
        /** Authorizes access to run-event snapshots. */
        query: RunEventQuery;
        /** Sets the optional run-event heartbeat interval in milliseconds. */
        heartbeatMs?: number;
      }>
    | undefined;
  /** Handles requests to decide approvals. */
  decideApproval: DecideApproval;
}>;
