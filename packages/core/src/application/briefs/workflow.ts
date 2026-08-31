import { createHash } from 'node:crypto';
import {
  type ApprovalAuthority,
  type ApprovalRequirement,
  type ApprovalRequirementInput,
  decideApprovalRequirement
} from '../../domain/briefs/policy.js';
import { collectDealBriefReferences } from '../../domain/briefs/references.js';
import {
  type CommercialArtifact,
  type ConversationArtifact,
  commercialArtifactSchema,
  conversationArtifactSchema,
  countSubstantiveBriefSections,
  type DealBrief,
  dealBriefSchema,
  MAX_LIST_ITEMS,
  MIN_SUBSTANTIVE_BRIEF_SECTIONS,
  type ReviewWarning,
  type StakeholderArtifact,
  stakeholderArtifactSchema
} from '../../domain/briefs/schema.js';
import {
  AuthorizationDeniedError,
  DomainConflictError,
  DomainNotFoundError,
  DomainValidationError
} from '../../domain/shared/errors.js';
import type { RunId } from '../../domain/shared/ids.js';
import type { AgentContext, StrategyArtifacts } from '../agents/contracts.js';
import type { WorkflowCommand } from '../workflow/command-queue.js';
import type {
  RunLifecycleStore,
  StepExecutionStore,
  StepLease,
  WorkflowRun
} from '../workflow/workflow-store.js';

/** Retrieval data retained by the workflow before a per-attempt generation context is attached. */
export type DealBriefRetrievalContext = Readonly<{
  opportunityId?: string;
  manifestId?: string;
  runId?: AgentContext['runId'];
  account?: AgentContext['account'];
  opportunity?: AgentContext['opportunity'];
  manifest?: AgentContext['manifest'];
  currentScope?: AgentContext['currentScope'];
  manifestEntries?: AgentContext['manifestEntries'];
  evidence?: AgentContext['evidence'];
}>;

export interface DealBriefAccessControl {
  authorizeStart(
    input: Readonly<{ requestedBy: string; opportunityId: string }>
  ): Promise<Readonly<{ allowed: false }> | Readonly<{ allowed: true; accountId: string }>>;
  authoritiesFor(
    input: Readonly<{ actorId: string; opportunityId: string }>
  ): Promise<readonly ApprovalAuthority[]>;
  validateApprovalEdit(
    input: Readonly<{
      actorId: string;
      opportunityId: string;
      runId: string;
      originalPayload: DealBrief;
      payload: DealBrief;
    }>
  ): Promise<ApprovalRequirement>;
  recordOpaqueDenial(event: Readonly<Record<string, unknown>>): Promise<void>;
}
export interface DealBriefWorkflowServices {
  retrieve(run: WorkflowRun, invocationId: string): Promise<DealBriefRetrievalContext>;
  conversation(
    run: WorkflowRun,
    context: DealBriefRetrievalContext,
    invocationId: string
  ): Promise<ConversationArtifact>;
  stakeholder(
    run: WorkflowRun,
    context: DealBriefRetrievalContext,
    invocationId: string
  ): Promise<StakeholderArtifact>;
  commercial(
    run: WorkflowRun,
    context: DealBriefRetrievalContext,
    invocationId: string
  ): Promise<CommercialArtifact>;
  strategy(
    run: WorkflowRun,
    input: Readonly<{ context: DealBriefRetrievalContext } & StrategyArtifacts>,
    invocationId: string
  ): Promise<DealBrief>;
  approvalInput(
    run: WorkflowRun,
    brief: DealBrief,
    commercial: CommercialArtifact
  ): ApprovalRequirementInput | Promise<ApprovalRequirementInput>;
  validateDraft(payload: unknown): DealBrief | Promise<DealBrief>;
}
export type StartDealBriefCommand = Readonly<{
  opportunityId: string;
  requestedBy: string;
  idempotencyKey: string;
}>;
export type RegenerateDealBriefCommand = Readonly<{
  runId: string;
  requestedBy: string;
  idempotencyKey: string;
}>;
export type CancelDealBriefCommand = Readonly<{ runId: string; requestedBy: string }>;
export type ProcessDealBriefStepCommand = Readonly<{ command: WorkflowCommand; workerId: string }>;
type WorkflowStep = 'start' | 'retrieve' | 'specialists' | 'synthesize' | 'validate' | 'finalize';
const SECTION_IDS = Object.freeze([
  'section:dealSnapshot',
  'section:executiveSummary',
  'section:buyerGoalsAndBusinessDrivers',
  'section:stakeholderMap',
  'section:negotiationState',
  'section:recommendedNextActions',
  'section:missingInformation',
  'section:sourceEvidence',
  'section:confidenceAndReviewWarnings'
]);

/** Serializes a value deterministically so hashes and idempotency checks agree. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new DomainValidationError('Payload is not canonically serializable');
  return serialized;
}
/** Produces the immutable hash used to bind approval payloads. */
export function hashApprovalPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
/** Derives a repeatable internal identifier from its stable business inputs. */
function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;
}
/** Builds an idempotent command for the next deal-brief workflow step. */
function workflowCommand(
  runId: RunId,
  step: WorkflowStep,
  discriminator: string,
  payload: Readonly<Record<string, unknown>> = {}
): WorkflowCommand {
  return {
    id: stableId('command', runId, step, discriminator),
    runId,
    type: 'process-deal-brief-step',
    payload: { step, ...payload },
    idempotencyKey: `${runId}:${step}:${discriminator}`
  };
}
/** Reads and validates the workflow step carried by a command. */
function readStep(command: WorkflowCommand): WorkflowStep {
  const step = command.payload.step;
  if (
    !['start', 'retrieve', 'specialists', 'synthesize', 'validate', 'finalize'].includes(
      String(step)
    )
  )
    throw new DomainValidationError('Unknown workflow step');
  return step as WorkflowStep;
}
/** Reads an object-valued checkpoint or reports the missing workflow dependency. */
function readCheckpointValue(
  checkpoint: Readonly<Record<string, unknown>> | undefined,
  name: string
): Readonly<Record<string, unknown>> {
  const value = checkpoint?.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainConflictError(`Required ${name} checkpoint is missing`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/** Reads the immutable evidence manifest ID carried by the retrieval checkpoint. */
function currentEvidenceManifestId(context: DealBriefRetrievalContext): string {
  if (context.manifest !== undefined) return context.manifest.id;
  if (context.manifestId !== undefined) return context.manifestId;
  throw new DomainConflictError('Retrieval checkpoint is missing its evidence manifest ID');
}

/** Builds an empty schema-valid specialist artifact that makes degradation explicit. */
function degradedSpecialistArtifact(
  name: 'conversation' | 'stakeholder',
  manifestId: string
): ConversationArtifact | StakeholderArtifact {
  if (name === 'conversation') {
    return conversationArtifactSchema.parse({
      evidenceManifestId: manifestId,
      goals: [],
      concerns: [],
      commitments: [],
      objections: [],
      missingContext: [],
      claims: [],
      reviewWarnings: [
        {
          code: 'CONVERSATION_SPECIALIST_UNAVAILABLE',
          severity: 'warning',
          message:
            'Conversation specialist was unavailable; conversation-derived claims were omitted.',
          claimIds: []
        }
      ]
    });
  }
  return stakeholderArtifactSchema.parse({
    evidenceManifestId: manifestId,
    stakeholders: [],
    coverageGaps: [],
    claims: [],
    reviewWarnings: [
      {
        code: 'STAKEHOLDER_SPECIALIST_UNAVAILABLE',
        severity: 'warning',
        message: 'Stakeholder specialist was unavailable; stakeholder-derived claims were omitted.',
        claimIds: []
      }
    ]
  });
}

/** Reconstructs the bounded retrieval context stored in a workflow checkpoint. */
function retrievalContextOf(
  checkpoint: Readonly<Record<string, unknown>> | undefined
): DealBriefRetrievalContext {
  return readCheckpointValue(checkpoint, 'retrieval') as DealBriefRetrievalContext;
}

/** Parses degraded and manifest-bearing artifacts at the workflow-store boundary. */
function specialistArtifactOf(
  checkpoint: Readonly<Record<string, unknown>> | undefined,
  name: 'conversation'
): ConversationArtifact;
function specialistArtifactOf(
  checkpoint: Readonly<Record<string, unknown>> | undefined,
  name: 'stakeholder'
): StakeholderArtifact;
function specialistArtifactOf(
  checkpoint: Readonly<Record<string, unknown>> | undefined,
  name: 'commercial'
): CommercialArtifact;
function specialistArtifactOf(
  checkpoint: Readonly<Record<string, unknown>> | undefined,
  name: 'conversation' | 'stakeholder' | 'commercial'
): ConversationArtifact | StakeholderArtifact | CommercialArtifact {
  const value = readCheckpointValue(checkpoint, name);
  const shouldParse =
    checkpoint?.status === 'degraded' || Object.hasOwn(value, 'evidenceManifestId');
  if (!shouldParse) return value as ConversationArtifact | StakeholderArtifact | CommercialArtifact;
  if (name === 'conversation') return conversationArtifactSchema.parse(value);
  if (name === 'stakeholder') return stakeholderArtifactSchema.parse(value);
  return commercialArtifactSchema.parse(value);
}

/** Collects claim identifiers retained in the synthesized brief. */
function retainedClaimIds(brief: DealBrief): ReadonlySet<string> {
  const claimIds = new Set<string>();
  const collect = (claims: readonly Readonly<{ id: string }>[] | undefined): void => {
    if (claims === undefined) return;
    for (const claim of claims) claimIds.add(claim.id);
  };
  collect(brief.dealSnapshot.claims);
  collect(brief.executiveSummary.claims);
  collect(brief.buyerGoalsAndBusinessDrivers.claims);
  collect(brief.stakeholderMap.claims);
  for (const stakeholder of brief.stakeholderMap.stakeholders) collect(stakeholder.claims);
  collect(brief.negotiationState.claims);
  for (const action of brief.recommendedNextActions.actions) collect(action.claims);
  for (const evidence of brief.sourceEvidence.evidence) collect(evidence.claims);
  return claimIds;
}

/** Adds validated specialist warnings without allowing model output to displace them. */
function mergeSpecialistReviewWarnings(
  brief: DealBrief,
  artifacts: readonly Readonly<{ reviewWarnings?: readonly ReviewWarning[] }>[]
): DealBrief {
  const specialistWarnings = artifacts.flatMap((artifact) => artifact.reviewWarnings ?? []);
  const validClaimIds = retainedClaimIds(brief);
  const specialistKeys = new Set(
    specialistWarnings.map(
      (warning) => `${warning.code}\u0000${warning.severity}\u0000${warning.message}`
    )
  );
  const warnings: ReviewWarning[] = [];
  const indexes = new Map<string, number>();
  for (const warning of [...brief.confidenceAndReviewWarnings.warnings, ...specialistWarnings]) {
    const key = `${warning.code}\u0000${warning.severity}\u0000${warning.message}`;
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, warnings.length);
      warnings.push({
        ...warning,
        claimIds: [...new Set(warning.claimIds.filter((claimId) => validClaimIds.has(claimId)))]
      });
      continue;
    }
    const existing = warnings[existingIndex];
    if (existing === undefined)
      throw new DomainValidationError('Merged review warning index is out of bounds');
    warnings[existingIndex] = {
      ...existing,
      claimIds: [
        ...new Set(
          [...existing.claimIds, ...warning.claimIds].filter((claimId) =>
            validClaimIds.has(claimId)
          )
        )
      ].slice(0, MAX_LIST_ITEMS)
    };
  }
  while (warnings.length > MAX_LIST_ITEMS) {
    let removableIndex = -1;
    for (let index = warnings.length - 1; index >= 0; index -= 1) {
      const warning = warnings[index];
      if (warning === undefined)
        throw new DomainValidationError('Merged review warning index is out of bounds');
      const key = `${warning.code}\u0000${warning.severity}\u0000${warning.message}`;
      if (!specialistKeys.has(key)) {
        removableIndex = index;
        break;
      }
    }
    warnings.splice(removableIndex < 0 ? warnings.length - 1 : removableIndex, 1);
  }
  return dealBriefSchema.parse({
    ...brief,
    confidenceAndReviewWarnings: {
      ...brief.confidenceAndReviewWarnings,
      warnings
    }
  });
}
/** Describes one model generation attempt for audit and duplicate detection. */
function generation(run: WorkflowRun, lease: StepLease, operation: string) {
  return {
    logicalGenerationId: stableId('generation', run.id, operation),
    operation,
    provider: run.generationProvider,
    model: run.generationModel,
    invocationId: lease.invocationId,
    possibleDuplicate: lease.attempt > 1
  } as const;
}
/** Validates that a brief is safe, cited, and substantive enough for approval. */
export function assertApprovableBrief(value: unknown): DealBrief {
  const parsed = dealBriefSchema.parse(value);
  const serialized = canonicalJson(parsed);
  if (
    /(?:BEGIN|END)_UNTRUSTED|\b[A-Z0-9]+_SENTINEL\b|ignore (?:all |the |any )?(?:previous|prior|system)|system prompt|(?:call|invoke|use) (?:a |the )?tool|role\s*:/i.test(
      serialized
    )
  )
    throw new DomainValidationError('Approval payload contains unsafe instruction-like language');
  const unsupported: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    if (
      typeof record.statement === 'string' &&
      Array.isArray(record.citations) &&
      record.citations.length === 0
    )
      unsupported.push(record.statement);
    Object.values(record).forEach(visit);
  };
  visit(parsed);
  if (unsupported.length > 0)
    throw new DomainValidationError('Approval payload contains a claim without citations');
  const substantiveSectionCount = countSubstantiveBriefSections(parsed);
  if (substantiveSectionCount < MIN_SUBSTANTIVE_BRIEF_SECTIONS)
    throw new DomainValidationError('Approval payload lacks substantive grounded coverage', {
      substantiveSectionCount,
      requiredSubstantiveSections: MIN_SUBSTANTIVE_BRIEF_SECTIONS
    });
  if (parsed.confidenceAndReviewWarnings.overallConfidence === 0)
    throw new DomainValidationError('Approval payload has zero confidence');
  const hasRetainedApprovalContent =
    collectDealBriefReferences(parsed).evidenceIds.length > 0 ||
    parsed.stakeholderMap.stakeholders.length > 0 ||
    parsed.recommendedNextActions.actions.length > 0 ||
    parsed.negotiationState.risks.length > 0;
  if (!hasRetainedApprovalContent)
    throw new DomainValidationError('Approval payload has no retained deal content');
  return parsed;
}

/** Starts authorized deal-brief runs while enforcing idempotency and active-run reuse. */
export class StartDealBrief {
  /** Provides persistence, access control, and the selected generation model. */
  public constructor(
    private readonly store: RunLifecycleStore,
    private readonly access: DealBriefAccessControl,
    private readonly model: Readonly<{ provider: string; model: string }>
  ) {}
  /** Authorizes and starts a deal-brief run, returning an existing run when appropriate. */
  public async execute(input: StartDealBriefCommand): Promise<RunId> {
    if (input.idempotencyKey.trim().length === 0)
      throw new DomainValidationError('Idempotency key is required');
    const runId = stableId(
      'run',
      input.requestedBy,
      input.opportunityId,
      input.idempotencyKey
    ) as RunId;
    const authorization = await this.access.authorizeStart({
      requestedBy: input.requestedBy,
      opportunityId: input.opportunityId
    });
    if (!authorization.allowed) {
      await this.access.recordOpaqueDenial({
        type: 'deal_brief_start_denied',
        actorId: input.requestedBy,
        reason: 'forbidden'
      });
      throw new AuthorizationDeniedError('DealBrief start denied');
    }
    const requestHash = hashApprovalPayload({
      opportunityId: input.opportunityId,
      requestedBy: input.requestedBy,
      idempotencyKey: input.idempotencyKey,
      generationProvider: this.model.provider,
      generationModel: this.model.model
    });
    const scope = {
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.requestedBy as WorkflowRun['requestedBy'],
      opportunityId: input.opportunityId as WorkflowRun['opportunityId']
    };
    const replay = await this.store.findRunByIdempotencyKey(scope);
    if (replay !== undefined) {
      if (replay.startRequestHash !== requestHash)
        throw new DomainConflictError('Start idempotency key is bound to a different command');
      return replay.id;
    }
    const active = await this.store.findActiveRun(scope);
    if (active !== undefined) return active.id;
    try {
      return (
        await this.store.startRun({
          id: runId,
          opportunityId: scope.opportunityId,
          requestedBy: scope.requestedBy,
          status: 'created',
          generationProvider: this.model.provider,
          generationModel: this.model.model,
          startRequestHash: requestHash,
          idempotencyKey: input.idempotencyKey,
          command: workflowCommand(runId, 'start', 'v1'),
          budget: { scope: runId, maxCalls: 24, deadlineMs: 600_000 }
        })
      ).id;
    } catch (error) {
      if (!(error instanceof DomainConflictError)) throw error;
      const concurrent = await this.store.findActiveRun(scope);
      if (concurrent === undefined) throw error;
      return concurrent.id;
    }
  }
}

/** Restarts synthesis for an authorized approval-bound deal brief. */
export class RegenerateDealBrief {
  /** Provides persistence and access control for regeneration requests. */
  public constructor(
    private readonly store: RunLifecycleStore,
    private readonly access: DealBriefAccessControl
  ) {}
  /** Authorizes regeneration and schedules a new draft for the existing run. */
  public async execute(input: RegenerateDealBriefCommand): Promise<RunId> {
    const run = await this.store.getRun(input.runId as RunId);
    if (run === undefined) throw new DomainNotFoundError('run');
    const authorized = await this.access.authorizeStart({
      requestedBy: input.requestedBy,
      opportunityId: run.opportunityId
    });
    if (!authorized.allowed || run.requestedBy !== input.requestedBy) {
      await this.access.recordOpaqueDenial({
        type: 'deal_brief_regeneration_denied',
        actorId: input.requestedBy,
        reason: 'forbidden'
      });
      throw new AuthorizationDeniedError('DealBrief regeneration denied');
    }
    const requestHash = hashApprovalPayload({
      runId: input.runId,
      requestedBy: input.requestedBy,
      idempotencyKey: input.idempotencyKey
    });
    const replay = await this.store.findRegenerationByIdempotencyKey({
      idempotencyKey: input.idempotencyKey,
      requestHash
    });
    if (replay !== undefined) return replay.id;
    if (!['awaiting_approval', 'rejected'].includes(run.status))
      throw new DomainConflictError('Only an approval-bound draft can be regenerated');
    const draftVersion = run.version + 1;
    await this.store.regenerateRun({
      runId: run.id,
      expectedVersion: run.version,
      requestedBy: run.requestedBy,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      command: workflowCommand(run.id, 'synthesize', `regenerate:${draftVersion}`, { draftVersion })
    });
    return run.id;
  }
}

/** Cancels an active run while retaining its checkpoints, artifacts, events, and trace history. */
export class CancelDealBrief {
  /** Provides the persistence and access checks needed to cancel a run. */
  public constructor(
    private readonly store: Pick<RunLifecycleStore, 'getRun' | 'cancelRun'>,
    private readonly access: Pick<DealBriefAccessControl, 'authorizeStart' | 'recordOpaqueDenial'>
  ) {}

  /** Authorizes cancellation and moves an active run to its cancelled state. */
  public async execute(input: CancelDealBriefCommand): Promise<WorkflowRun> {
    const run = await this.store.getRun(input.runId as RunId);
    if (run === undefined) throw new DomainNotFoundError('run');
    const authorization = await this.access.authorizeStart({
      requestedBy: input.requestedBy,
      opportunityId: run.opportunityId
    });
    if (!authorization.allowed || run.requestedBy !== input.requestedBy) {
      await this.access.recordOpaqueDenial({
        type: 'deal_brief_cancellation_denied',
        actorId: input.requestedBy,
        reason: 'forbidden'
      });
      throw new AuthorizationDeniedError('DealBrief cancellation denied');
    }
    if (['completed', 'rejected', 'failed', 'cancelled'].includes(run.status))
      throw new DomainConflictError('Terminal runs cannot be cancelled');
    return this.store.cancelRun({
      runId: run.id,
      expectedVersion: run.version,
      cancelledBy: run.requestedBy
    });
  }
}

/** Identifies a workflow failure that should end the run instead of being retried. */
class FatalDealBriefWorkflowError extends Error {
  /** Preserves the stable failure reason and its original cause. */
  public constructor(
    public readonly reason: string,
    cause: unknown
  ) {
    super(reason, { cause });
    this.name = 'FatalDealBriefWorkflowError';
  }
}

/** Advances each deal-brief workflow step and records retry-safe checkpoints. */
export class ProcessDealBriefStep {
  private readonly leaseMs: number;
  /** Provides workflow persistence, step services, and the lease duration for processing. */
  public constructor(
    private readonly store: StepExecutionStore,
    private readonly services: DealBriefWorkflowServices,
    options: Readonly<{ leaseMs: number }>
  ) {
    if (!Number.isInteger(options.leaseMs) || options.leaseMs < 1_000)
      throw new RangeError('Workflow lease must be at least one second');
    this.leaseMs = options.leaseMs;
  }
  /** Claims and executes one workflow step with heartbeat and terminal-failure handling. */
  public async execute(input: ProcessDealBriefStepCommand): Promise<void> {
    const step = readStep(input.command);
    const run = await this.store.getRun(input.command.runId);
    if (run === undefined) throw new DomainNotFoundError('run');
    if (['completed', 'rejected', 'failed', 'cancelled', 'awaiting_approval'].includes(run.status))
      return;
    const lease = await this.store.claimStep({
      runId: run.id,
      step,
      invocationId: stableId('invocation', input.command.id, input.workerId, crypto.randomUUID()),
      causalCommandId: input.command.id,
      owner: input.workerId,
      leaseMs: this.leaseMs
    });
    if (lease === undefined) return;
    const current = await this.store.getRun(run.id);
    if (current === undefined) throw new DomainNotFoundError('run');
    const heartbeat = setInterval(
      () => {
        void this.store.heartbeatStep({
          invocationId: lease.invocationId,
          owner: lease.owner,
          leaseToken: lease.leaseToken,
          leaseMs: this.leaseMs
        });
      },
      Math.max(500, Math.floor(this.leaseMs / 3))
    );
    heartbeat.unref();
    try {
      if (step === 'start')
        await this.advance(current, lease, input.command, 'start', 'start', {}, 'retrieve');
      else if (step === 'retrieve') await this.retrieve(current, lease, input.command);
      else if (step === 'specialists') await this.specialists(current, lease, input.command);
      else if (step === 'synthesize') await this.synthesize(current, lease, input.command);
      else if (step === 'validate') await this.validate(current, lease, input.command);
      else await this.finalize(current, lease, input.command);
    } catch (error) {
      if (!(error instanceof FatalDealBriefWorkflowError)) {
        await this.store.abandonStep({
          invocationId: lease.invocationId,
          owner: lease.owner,
          leaseToken: lease.leaseToken
        });
        throw error;
      }
      const latest = await this.store.getRun(run.id);
      if (
        latest !== undefined &&
        !['completed', 'rejected', 'failed', 'cancelled', 'awaiting_approval'].includes(
          latest.status
        )
      ) {
        await this.store.failRun({
          runId: latest.id,
          expectedVersion: latest.version,
          invocationId: lease.invocationId,
          invocationOwner: lease.owner,
          leaseToken: lease.leaseToken,
          causalCommandId: input.command.id,
          reason: error.reason
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
  /** Commits a completed checkpoint and schedules the next workflow step atomically. */
  private async advance(
    run: WorkflowRun,
    lease: StepLease,
    causal: WorkflowCommand,
    event: Parameters<StepExecutionStore['commitStepAndEnqueueNext']>[0]['event'],
    checkpointStep: string,
    checkpoint: Readonly<Record<string, unknown>>,
    next: WorkflowStep,
    nextPayload: Readonly<Record<string, unknown>> = {}
  ) {
    await this.store.commitStepAndEnqueueNext({
      runId: run.id,
      expectedVersion: run.version,
      invocationId: lease.invocationId,
      invocationOwner: lease.owner,
      leaseToken: lease.leaseToken,
      causalCommandId: causal.id,
      event,
      checkpointStep,
      checkpoint,
      nextCommand: workflowCommand(
        run.id,
        next,
        `${event}:${String(nextPayload.draftVersion ?? '')}`,
        nextPayload
      )
    });
  }
  /** Retrieves and checkpoints the evidence context needed by every specialist. */
  private async retrieve(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand) {
    const existing = await this.store.getCheckpoint({ runId: run.id, step: 'retrieval' });
    const retrieved = existing ?? {
      status: 'completed',
      value: await this.services.retrieve(run, lease.invocationId)
    };
    await this.advance(
      run,
      lease,
      causal,
      'retrieval_completed',
      'retrieval',
      retrieved,
      'specialists'
    );
  }
  /** Runs missing specialists concurrently and persists their outcomes in deterministic order. */
  private async specialists(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand) {
    const context = retrievalContextOf(
      await this.store.getCheckpoint({ runId: run.id, step: 'retrieval' })
    );
    const manifestId = currentEvidenceManifestId(context);
    const names = ['conversation', 'stakeholder', 'commercial'] as const;
    const checkpoints = await Promise.all(
      names.map(async (name) => ({
        name,
        checkpoint: await this.store.getCheckpoint({ runId: run.id, step: `specialist:${name}` })
      }))
    );
    const missing = checkpoints.filter(({ checkpoint }) => checkpoint === undefined);
    const attempts = missing.map(({ name }) => ({
      name,
      generationMetadata: generation(run, lease, name),
      promise: this.services[name](run, context, lease.invocationId)
    }));
    const outcomes = await Promise.allSettled(attempts.map(({ promise }) => promise));
    if (outcomes.length !== attempts.length) {
      throw new FatalDealBriefWorkflowError(
        'specialist_outcome_cardinality_mismatch',
        new RangeError('Specialist attempt and outcome counts differ')
      );
    }

    for (const [index, attempt] of attempts.entries()) {
      const outcome = outcomes[index];
      if (outcome === undefined) {
        throw new FatalDealBriefWorkflowError(
          'specialist_outcome_cardinality_mismatch',
          new RangeError(`Missing outcome for ${attempt.name} specialist`)
        );
      }
      let checkpoint: Readonly<Record<string, unknown>>;
      if (outcome.status === 'fulfilled') {
        checkpoint = {
          status: 'completed',
          value: outcome.value,
          generation: attempt.generationMetadata
        };
      } else {
        if (attempt.name === 'commercial') {
          throw new FatalDealBriefWorkflowError('commercial_specialist_failed', outcome.reason);
        }
        checkpoint = {
          status: 'degraded',
          value: degradedSpecialistArtifact(attempt.name, manifestId),
          warning: `${attempt.name} specialist unavailable; dependent claims removed`,
          generation: attempt.generationMetadata
        };
      }
      await this.store.saveCheckpoint({
        runId: run.id,
        step: `specialist:${attempt.name}`,
        invocationId: lease.invocationId,
        invocationOwner: lease.owner,
        leaseToken: lease.leaseToken,
        logicalGenerationId: attempt.generationMetadata.logicalGenerationId,
        checkpoint
      });
    }
    await this.advance(
      run,
      lease,
      causal,
      'specialists_completed',
      'specialists',
      { status: 'completed' },
      'synthesize'
    );
  }

  /** Synthesizes a draft from completed or schema-valid degraded specialist artifacts. */
  private async synthesize(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand) {
    const context = retrievalContextOf(
      await this.store.getCheckpoint({ runId: run.id, step: 'retrieval' })
    );
    const conversation = specialistArtifactOf(
      await this.store.getCheckpoint({ runId: run.id, step: 'specialist:conversation' }),
      'conversation'
    );
    const stakeholder = specialistArtifactOf(
      await this.store.getCheckpoint({ runId: run.id, step: 'specialist:stakeholder' }),
      'stakeholder'
    );
    const commercial = specialistArtifactOf(
      await this.store.getCheckpoint({ runId: run.id, step: 'specialist:commercial' }),
      'commercial'
    );
    const draftVersion =
      typeof causal.payload.draftVersion === 'number' ? causal.payload.draftVersion : 1;
    const strategyStep = `strategy:${draftVersion}`;
    const existing = await this.store.getCheckpoint({ runId: run.id, step: strategyStep });
    let parsed: DealBrief;
    try {
      const value =
        existing?.value ??
        (await this.services.strategy(
          run,
          { context, conversation, stakeholder, commercial },
          lease.invocationId
        ));
      parsed = mergeSpecialistReviewWarnings(await this.services.validateDraft(value), [
        conversation,
        stakeholder,
        commercial
      ]);
    } catch (error) {
      throw new FatalDealBriefWorkflowError('strategy_generation_failed', error);
    }
    if (existing === undefined) {
      const generationMetadata = generation(run, lease, `strategy:${draftVersion}`);
      await this.store.saveCheckpoint({
        runId: run.id,
        step: strategyStep,
        invocationId: lease.invocationId,
        invocationOwner: lease.owner,
        leaseToken: lease.leaseToken,
        logicalGenerationId: generationMetadata.logicalGenerationId,
        checkpoint: { status: 'completed', value: parsed, generation: generationMetadata }
      });
    }
    await this.advance(
      run,
      lease,
      causal,
      'synthesis_completed',
      `synthesis:${draftVersion}`,
      { status: 'completed' },
      'validate',
      { draftVersion }
    );
  }
  /** Validates a synthesized draft and either opens approval or advances to finalization. */
  private async validate(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand) {
    const draftVersion =
      typeof causal.payload.draftVersion === 'number' ? causal.payload.draftVersion : 1;
    const strategy = await this.store.getCheckpoint({
      runId: run.id,
      step: `strategy:${draftVersion}`
    });
    const commercial = specialistArtifactOf(
      await this.store.getCheckpoint({ runId: run.id, step: 'specialist:commercial' }),
      'commercial'
    );
    let payload: DealBrief;
    let requirement: ApprovalRequirement;
    try {
      payload = assertApprovableBrief(await this.services.validateDraft(strategy?.value));
      requirement = decideApprovalRequirement(
        await this.services.approvalInput(run, payload, commercial)
      );
    } catch (error) {
      throw new FatalDealBriefWorkflowError('draft_validation_failed', error);
    }
    const subjectHash = hashApprovalPayload(payload);
    const recommendationIds = payload.recommendedNextActions.actions.map(
      (action, index) => `recommendation:${index}:${hashApprovalPayload(action).slice(0, 16)}`
    );
    if (requirement.entries.length > 0) {
      const citationIds = collectDealBriefReferences(payload).citations.map(
        (citation) => citation.id
      );
      await this.store.awaitApproval({
        runId: run.id,
        expectedVersion: run.version,
        invocationId: lease.invocationId,
        invocationOwner: lease.owner,
        leaseToken: lease.leaseToken,
        causalCommandId: causal.id,
        subject: {
          id: stableId('approval_subject', run.id, String(draftVersion), subjectHash),
          runId: run.id,
          subjectHash,
          payload,
          sectionIds: SECTION_IDS,
          recommendationIds,
          citationIds,
          policyTriggers: requirement.policyTriggers,
          entries: requirement.entries,
          quorumVersion: requirement.quorumVersion
        }
      });
      return;
    }
    await this.store.commitStepAndEnqueueNext({
      runId: run.id,
      expectedVersion: run.version,
      invocationId: lease.invocationId,
      invocationOwner: lease.owner,
      leaseToken: lease.leaseToken,
      causalCommandId: causal.id,
      event: 'validation_completed',
      checkpointStep: `validation:${draftVersion}`,
      checkpoint: { status: 'completed', subjectHash, payload },
      nextCommand: workflowCommand(run.id, 'finalize', subjectHash, { subjectHash, payload })
    });
  }
  /** Verifies the approved payload binding and persists the completed brief. */
  private async finalize(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand) {
    const payload = assertApprovableBrief(causal.payload.payload);
    const subjectHash = causal.payload.subjectHash;
    if (typeof subjectHash !== 'string' || hashApprovalPayload(payload) !== subjectHash)
      throw new DomainConflictError('Finalization payload hash mismatch');
    await this.store.finalizeRun({
      runId: run.id,
      expectedVersion: run.version,
      invocationId: lease.invocationId,
      invocationOwner: lease.owner,
      leaseToken: lease.leaseToken,
      causalCommandId: causal.id,
      subjectHash,
      payload,
      ...(typeof causal.payload.approvalSubjectId === 'string'
        ? { approvalSubjectId: causal.payload.approvalSubjectId }
        : {})
    });
  }
}
