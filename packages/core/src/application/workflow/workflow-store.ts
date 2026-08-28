import type { RunEvent, RunStatus } from '../../domain/runs/contracts.js';
import type { OpportunityId, RunId, UserId } from '../../domain/shared/ids.js';
import type { WorkflowCommand } from './command-queue.js';
import type { RunBudgetLimits } from '../model/contracts.js';

export type WorkflowRun = Readonly<{
  id: RunId;
  opportunityId: OpportunityId;
  requestedBy: UserId;
  status: RunStatus;
  version: number;
  generationProvider: string;
  generationModel: string;
}>;

export type StepLease = Readonly<{
  invocationId: string;
  causalCommandId: string;
  runId: RunId;
  step: string;
  owner: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  attempt: number;
}>;

export type StartRunInput = Readonly<Omit<WorkflowRun, 'version'> & { command: WorkflowCommand; budget: RunBudgetLimits }>;
export type CommitStepInput = Readonly<{
  runId: RunId;
  expectedVersion: number;
  invocationId: string;
  invocationOwner: string;
  leaseToken: string;
  event: RunEvent;
  checkpoint: Readonly<Record<string, unknown>>;
  artifact?: Readonly<{ id: string; kind: string; content: Readonly<Record<string, unknown>>; evidenceManifestId?: string | undefined }>;
  nextCommand: WorkflowCommand;
}>;
type ApprovalDecisionBase = Readonly<{
  runId: RunId;
  expectedVersion: number;
  approvalSubjectId: string;
  actorId: UserId;
  rationale?: string | undefined;
  editedPayload?: Readonly<Record<string, unknown>> | undefined;
}>;
export type ApprovalDecisionInput = ApprovalDecisionBase & (
  | Readonly<{ action: 'approve_unchanged' | 'edit_and_approve'; finalizationCommand: WorkflowCommand }>
  | Readonly<{ action: 'reject'; finalizationCommand?: never }>
);

/** Atomic workflow transition seam. Implementations persist state, events and commands in one transaction. */
export interface WorkflowStore {
  startRun(input: StartRunInput): Promise<WorkflowRun>;
  claimStep(input: Readonly<{ runId: RunId; step: string; invocationId: string; causalCommandId: string; owner: string; leaseMs: number; now?: Date }>): Promise<StepLease | undefined>;
  heartbeatStep(input: Readonly<{ invocationId: string; owner: string; leaseToken: string; leaseMs: number; now?: Date }>): Promise<StepLease | undefined>;
  commitStepAndEnqueueNext(input: CommitStepInput): Promise<WorkflowRun>;
  awaitApproval(input: Readonly<{ runId: RunId; expectedVersion: number; invocationId: string; invocationOwner: string; leaseToken: string; causalCommandId: string; approvalSubjectId: string; subjectHash: string; payload: Readonly<Record<string, unknown>>; policyTriggers: readonly string[] }>): Promise<WorkflowRun>;
  recordDecisionAndEnqueueFinalization(input: ApprovalDecisionInput): Promise<WorkflowRun>;
}
