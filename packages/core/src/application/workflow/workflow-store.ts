import type { DealBrief } from '../../domain/briefs/schema.js';
import type { ApprovalAuthority, ApprovalCategory, ApprovalRequirementEntry } from '../../domain/briefs/policy.js';
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
  startRequestHash: string;
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

export type ApprovalAction = 'approve_unchanged' | 'edit_and_approve' | 'reject';

export type ApprovalDecision = Readonly<{
  action: ApprovalAction;
  entryId: string;
  category: ApprovalCategory;
  authority: ApprovalAuthority;
  actorId: UserId;
  originalPayload: DealBrief;
  approvedPayload: DealBrief;
  approvedSubjectHash: string;
  editedPayload?: DealBrief | undefined;
  diff?: Readonly<Record<string, unknown>> | undefined;
  rationale?: string | undefined;
  requestHash: string;
  decidedAt: string;
}>;

export type ApprovalSubject = Readonly<{
  id: string;
  runId: RunId;
  draftVersion: number;
  subjectHash: string;
  payload: DealBrief;
  sectionIds: readonly string[];
  recommendationIds: readonly string[];
  citationIds: readonly string[];
  policyTriggers: readonly string[];
  entries: readonly ApprovalRequirementEntry[];
  quorumVersion: string;
  decisions: readonly ApprovalDecision[];
  supersededBySubjectId?: string | undefined;
}>;

export type StartRunInput = Readonly<Omit<WorkflowRun, 'version'> & {
  command: WorkflowCommand;
  budget: RunBudgetLimits;
  idempotencyKey: string;
  startRequestHash: string;
}>;

export type SaveCheckpointInput = Readonly<{
  runId: RunId;
  step: string;
  invocationId: string;
  invocationOwner: string;
  leaseToken: string;
  logicalGenerationId?: string | undefined;
  checkpoint: Readonly<Record<string, unknown>>;
}>;

export type CommitStepInput = Readonly<{
  runId: RunId;
  expectedVersion: number;
  invocationId: string;
  invocationOwner: string;
  leaseToken: string;
  causalCommandId?: string;
  event: RunEvent;
  checkpointStep?: string;
  checkpoint: Readonly<Record<string, unknown>>;
  artifact?: Readonly<{
    id: string;
    kind: string;
    content: Readonly<Record<string, unknown>>;
    contentHash?: string | undefined;
    logicalGenerationId?: string | undefined;
    generationMetadata?: Readonly<Record<string, unknown>> | undefined;
    evidenceManifestId?: string | undefined;
  }>;
  nextCommand: WorkflowCommand;
}>;

export type AwaitApprovalInput = Readonly<{
  runId: RunId;
  expectedVersion: number;
  invocationId: string;
  invocationOwner: string;
  leaseToken: string;
  causalCommandId: string;
  subject: Omit<ApprovalSubject, 'draftVersion' | 'decisions'>;
}>;

export type ApprovalDecisionInput = Readonly<{
  runId: RunId;
  expectedVersion: number;
  approvalSubjectId: string;
  expectedSubjectHash: string;
  entryId: string;
  category: ApprovalCategory;
  authority: ApprovalAuthority;
  actorId: UserId;
  idempotencyKey: string;
  decision: ApprovalDecision;
  requestHash: string;
  finalizationCommand: WorkflowCommand;
}>;

export type ApprovalDecisionStoreResult = Readonly<{
  run: WorkflowRun;
  quorumSatisfied: boolean;
  rejected: boolean;
  replayed: boolean;
  approvedSubjectHash: string;
}>;

export type ReplaceApprovalSubjectInput = Readonly<{
  runId: RunId;
  expectedVersion: number;
  priorSubjectId: string;
  priorDecision: ApprovalDecision;
  idempotencyKey: string;
  requestHash: string;
  subject: Omit<ApprovalSubject, 'draftVersion' | 'decisions'>;
}>;

export type RegenerateRunInput = Readonly<{
  runId: RunId;
  expectedVersion: number;
  requestedBy: UserId;
  idempotencyKey: string;
  command: WorkflowCommand;
}>;

export type FinalizeRunInput = Readonly<{
  runId: RunId;
  expectedVersion: number;
  invocationId: string;
  invocationOwner: string;
  leaseToken: string;
  causalCommandId: string;
  approvalSubjectId?: string | undefined;
  subjectHash: string;
  payload: DealBrief;
}>;

/** Atomic workflow transition seam. Implementations persist state, events and commands in one transaction. */
export interface WorkflowStore {
  findRunByIdempotencyKey(input: Readonly<{ idempotencyKey: string; requestedBy: UserId; opportunityId: OpportunityId }>): Promise<WorkflowRun | undefined>;
  findActiveRun(input: Readonly<{ opportunityId: OpportunityId; requestedBy: UserId }>): Promise<WorkflowRun | undefined>;
  getRun(runId: RunId): Promise<WorkflowRun | undefined>;
  startRun(input: StartRunInput): Promise<WorkflowRun>;
  claimStep(input: Readonly<{ runId: RunId; step: string; invocationId: string; causalCommandId: string; owner: string; leaseMs: number; now?: Date }>): Promise<StepLease | undefined>;
  heartbeatStep(input: Readonly<{ invocationId: string; owner: string; leaseToken: string; leaseMs: number; now?: Date }>): Promise<StepLease | undefined>;
  getCheckpoint(input: Readonly<{ runId: RunId; step: string }>): Promise<Readonly<Record<string, unknown>> | undefined>;
  saveCheckpoint(input: SaveCheckpointInput): Promise<Readonly<Record<string, unknown>>>;
  commitStepAndEnqueueNext(input: CommitStepInput): Promise<WorkflowRun>;
  awaitApproval(input: AwaitApprovalInput): Promise<WorkflowRun>;
  getApprovalSubject(input: Readonly<{ runId: RunId; approvalSubjectId?: string | undefined }>): Promise<ApprovalSubject | undefined>;
  recordDecisionAndEnqueueFinalization(input: ApprovalDecisionInput): Promise<ApprovalDecisionStoreResult>;
  replaceApprovalSubject(input: ReplaceApprovalSubjectInput): Promise<Readonly<{ run: WorkflowRun; subject: ApprovalSubject; replayed: boolean }>>;
  regenerateRun(input: RegenerateRunInput): Promise<WorkflowRun>;
  finalizeRun(input: FinalizeRunInput): Promise<WorkflowRun>;
  failRun(input: Readonly<{ runId: RunId; expectedVersion: number; invocationId: string; invocationOwner: string; leaseToken: string; causalCommandId: string; reason: string }>): Promise<WorkflowRun>;
}
