import { createHash } from 'node:crypto';
import { decideApprovalRequirement, type ApprovalAuthority, type ApprovalRequirementInput } from '../../domain/briefs/policy.js';
import { dealBriefSchema, type DealBrief } from '../../domain/briefs/schema.js';
import { AuthorizationDeniedError, DomainConflictError, DomainNotFoundError, DomainValidationError } from '../../domain/shared/errors.js';
import type { RunId } from '../../domain/shared/ids.js';
import type { WorkflowCommand } from '../workflow/command-queue.js';
import type { StepLease, WorkflowRun, WorkflowStore } from '../workflow/workflow-store.js';

export interface DealBriefAccessControl {
  authorizeStart(input: Readonly<{ requestedBy: string; opportunityId: string }>): Promise<Readonly<{ allowed: false }> | Readonly<{ allowed: true; accountId: string }>>;
  authoritiesFor(input: Readonly<{ actorId: string; opportunityId: string }>): Promise<readonly ApprovalAuthority[]>;
  recordOpaqueDenial(event: Readonly<Record<string, unknown>>): Promise<void>;
}
export interface DealBriefWorkflowServices {
  retrieve(run: WorkflowRun, invocationId: string): Promise<Readonly<Record<string, unknown>>>;
  conversation(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string): Promise<Readonly<Record<string, unknown>>>;
  stakeholder(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string): Promise<Readonly<Record<string, unknown>>>;
  commercial(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string): Promise<Readonly<Record<string, unknown>>>;
  strategy(run: WorkflowRun, input: Readonly<{ context: Readonly<Record<string, unknown>>; conversation: Readonly<Record<string, unknown>>; stakeholder: Readonly<Record<string, unknown>>; commercial: Readonly<Record<string, unknown>> }>, invocationId: string): Promise<unknown>;
  approvalInput(run: WorkflowRun, brief: DealBrief, commercial: Readonly<Record<string, unknown>>): ApprovalRequirementInput | Promise<ApprovalRequirementInput>;
  validateDraft(payload: unknown): DealBrief | Promise<DealBrief>;
}
export type StartDealBriefCommand = Readonly<{ opportunityId: string; requestedBy: string; idempotencyKey: string; generationProvider: string; generationModel: string; budget: Readonly<{ maxCalls: number; maxInputTokens: number; maxOutputTokens: number; deadlineMs: number }> }>;
export type ProcessDealBriefStepCommand = Readonly<{ command: WorkflowCommand; workerId: string }>;
type WorkflowStep = 'start' | 'retrieve' | 'specialists' | 'synthesize' | 'validate' | 'finalize';
const SECTION_IDS = Object.freeze(['section:dealSnapshot', 'section:executiveSummary', 'section:buyerGoalsAndBusinessDrivers', 'section:stakeholderMap', 'section:negotiationState', 'section:recommendedNextActions', 'section:missingInformation', 'section:sourceEvidence', 'section:confidenceAndReviewWarnings']);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`; }
  const serialized = JSON.stringify(value); if (serialized === undefined) throw new DomainValidationError('Payload is not canonically serializable'); return serialized;
}
export function hashApprovalPayload(payload: unknown): string { return createHash('sha256').update(canonicalJson(payload)).digest('hex'); }
function stableId(prefix: string, ...parts: readonly string[]): string { return `${prefix}_${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`; }
function workflowCommand(runId: RunId, step: WorkflowStep, discriminator: string, payload: Readonly<Record<string, unknown>> = {}): WorkflowCommand {
  return { id: stableId('command', runId, step, discriminator), runId, type: 'process-deal-brief-step', payload: { step, ...payload }, idempotencyKey: `${runId}:${step}:${discriminator}` };
}
function readStep(command: WorkflowCommand): WorkflowStep {
  const step = command.payload.step; if (!['start', 'retrieve', 'specialists', 'synthesize', 'validate', 'finalize'].includes(String(step))) throw new DomainValidationError('Unknown workflow step'); return step as WorkflowStep;
}
function valueOf(checkpoint: Readonly<Record<string, unknown>> | undefined, name: string): Readonly<Record<string, unknown>> {
  const value = checkpoint?.value; if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DomainConflictError(`Required ${name} checkpoint is missing`); return value as Readonly<Record<string, unknown>>;
}
function generation(run: WorkflowRun, lease: StepLease, operation: string) {
  return { logicalGenerationId: stableId('generation', run.id, operation), operation, provider: run.generationProvider, model: run.generationModel, invocationId: lease.invocationId, possibleDuplicate: lease.attempt > 1 } as const;
}
function collectCitationIds(value: unknown): readonly string[] {
  const ids = new Set<string>(); const visit = (current: unknown): void => { if (Array.isArray(current)) { current.forEach(visit); return; } if (current === null || typeof current !== 'object') return; const record = current as Record<string, unknown>; if (typeof record.id === 'string' && typeof record.evidenceId === 'string' && typeof record.locator === 'string') ids.add(record.id); Object.values(record).forEach(visit); }; visit(value); return [...ids].sort();
}
export function assertApprovableBrief(value: unknown): DealBrief {
  const parsed = dealBriefSchema.parse(value); const serialized = canonicalJson(parsed);
  if (/(?:BEGIN|END)_UNTRUSTED|\b[A-Z0-9]+_SENTINEL\b|ignore (?:all |the |any )?(?:previous|prior|system)|system prompt|(?:call|invoke|use) (?:a |the )?tool|role\s*:/i.test(serialized)) throw new DomainValidationError('Approval payload contains unsafe instruction-like language');
  const unsupported: string[] = []; const visit = (current: unknown): void => { if (Array.isArray(current)) { current.forEach(visit); return; } if (current === null || typeof current !== 'object') return; const record = current as Record<string, unknown>; if (typeof record.statement === 'string' && Array.isArray(record.citations) && record.citations.length === 0) unsupported.push(record.statement); Object.values(record).forEach(visit); }; visit(parsed);
  if (unsupported.length > 0) throw new DomainValidationError('Approval payload contains a claim without citations'); return parsed;
}

export class StartDealBrief {
  public constructor(private readonly store: WorkflowStore, private readonly access: DealBriefAccessControl) {}
  public async execute(input: StartDealBriefCommand): Promise<RunId> {
    if (input.idempotencyKey.trim().length === 0) throw new DomainValidationError('Idempotency key is required');
    const replay = await this.store.findRunByIdempotencyKey(input.idempotencyKey); if (replay !== undefined) return replay.id;
    const authorization = await this.access.authorizeStart({ requestedBy: input.requestedBy, opportunityId: input.opportunityId });
    if (!authorization.allowed) { await this.access.recordOpaqueDenial({ type: 'deal_brief_start_denied', actorId: input.requestedBy, reason: 'forbidden' }); throw new AuthorizationDeniedError('DealBrief start denied'); }
    const active = await this.store.findActiveRun({ opportunityId: input.opportunityId as WorkflowRun['opportunityId'] }); if (active !== undefined) return active.id;
    const runId = stableId('run', input.requestedBy, input.opportunityId, input.idempotencyKey) as RunId;
    try {
      return (await this.store.startRun({ id: runId, opportunityId: input.opportunityId as WorkflowRun['opportunityId'], requestedBy: input.requestedBy as WorkflowRun['requestedBy'], status: 'created', generationProvider: input.generationProvider, generationModel: input.generationModel, idempotencyKey: input.idempotencyKey, command: workflowCommand(runId, 'start', 'v1'), budget: { scope: runId, ...input.budget } })).id;
    } catch (error) {
      if (!(error instanceof DomainConflictError)) throw error; const concurrent = await this.store.findActiveRun({ opportunityId: input.opportunityId as WorkflowRun['opportunityId'] }); if (concurrent === undefined) throw error; return concurrent.id;
    }
  }
}

export class ProcessDealBriefStep {
  private readonly leaseMs: number;
  public constructor(private readonly store: WorkflowStore, private readonly services: DealBriefWorkflowServices, options: Readonly<{ leaseMs: number }>) { if (!Number.isInteger(options.leaseMs) || options.leaseMs < 1_000) throw new RangeError('Workflow lease must be at least one second'); this.leaseMs = options.leaseMs; }
  public async execute(input: ProcessDealBriefStepCommand): Promise<void> {
    const step = readStep(input.command); const run = await this.store.getRun(input.command.runId); if (run === undefined) throw new DomainNotFoundError('run'); if (['completed', 'rejected', 'failed', 'awaiting_approval'].includes(run.status)) return;
    const lease = await this.store.claimStep({ runId: run.id, step, invocationId: stableId('invocation', input.command.id, input.workerId, crypto.randomUUID()), causalCommandId: input.command.id, owner: input.workerId, leaseMs: this.leaseMs }); if (lease === undefined) return;
    const current = await this.store.getRun(run.id); if (current === undefined) throw new DomainNotFoundError('run');
    const heartbeat = setInterval(() => { void this.store.heartbeatStep({ invocationId: lease.invocationId, owner: lease.owner, leaseToken: lease.leaseToken, leaseMs: this.leaseMs }); }, Math.max(500, Math.floor(this.leaseMs / 3))); heartbeat.unref();
    try {
      if (step === 'start') await this.advance(current, lease, input.command, 'start', 'start', {}, 'retrieve');
      else if (step === 'retrieve') await this.retrieve(current, lease, input.command);
      else if (step === 'specialists') await this.specialists(current, lease, input.command);
      else if (step === 'synthesize') await this.synthesize(current, lease, input.command);
      else if (step === 'validate') await this.validate(current, lease, input.command);
      else await this.finalize(current, lease, input.command);
    } catch (error) {
      const latest = await this.store.getRun(run.id); if (latest !== undefined && !['completed', 'rejected', 'failed', 'awaiting_approval'].includes(latest.status)) await this.store.failRun({ runId: latest.id, expectedVersion: latest.version, invocationId: lease.invocationId, invocationOwner: lease.owner, leaseToken: lease.leaseToken, causalCommandId: input.command.id, reason: error instanceof Error ? error.name : 'UnknownWorkflowError' });
    } finally { clearInterval(heartbeat); }
  }
  private async advance(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand, event: Parameters<WorkflowStore['commitStepAndEnqueueNext']>[0]['event'], checkpointStep: string, checkpoint: Readonly<Record<string, unknown>>, next: WorkflowStep) {
    await this.store.commitStepAndEnqueueNext({ runId: run.id, expectedVersion: run.version, invocationId: lease.invocationId, invocationOwner: lease.owner, leaseToken: lease.leaseToken, causalCommandId: causal.id, event, checkpointStep, checkpoint, nextCommand: workflowCommand(run.id, next, event) });
  }
  private async retrieve(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand) {
    const existing = await this.store.getCheckpoint({ runId: run.id, step: 'retrieval' }); const retrieved = existing ?? { status: 'completed', value: await this.services.retrieve(run, lease.invocationId) }; await this.advance(run, lease, causal, 'retrieval_completed', 'retrieval', retrieved, 'specialists');
  }
  private async specialists(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand) {
    const context = valueOf(await this.store.getCheckpoint({ runId: run.id, step: 'retrieval' }), 'retrieval'); const names = ['conversation', 'stakeholder', 'commercial'] as const;
    const results = await Promise.allSettled(names.map(async (name) => {
      const step = `specialist:${name}`; const existing = await this.store.getCheckpoint({ runId: run.id, step }); if (existing !== undefined) return existing;
      const generationMetadata = generation(run, lease, name);
      try { const checkpoint = { status: 'completed', value: await this.services[name](run, context, lease.invocationId), generation: generationMetadata }; return this.store.saveCheckpoint({ runId: run.id, step, invocationId: lease.invocationId, invocationOwner: lease.owner, leaseToken: lease.leaseToken, logicalGenerationId: generationMetadata.logicalGenerationId, checkpoint }); }
      catch (error) { if (name === 'commercial') throw error; const checkpoint = { status: 'degraded', value: { warnings: [`${name}_unavailable`], claims: [] }, warning: `${name} specialist unavailable; dependent claims removed`, generation: generationMetadata }; return this.store.saveCheckpoint({ runId: run.id, step, invocationId: lease.invocationId, invocationOwner: lease.owner, leaseToken: lease.leaseToken, logicalGenerationId: generationMetadata.logicalGenerationId, checkpoint }); }
    }));
    if (results[2]?.status === 'rejected') throw results[2].reason; await this.advance(run, lease, causal, 'specialists_completed', 'specialists', { status: 'completed' }, 'synthesize');
  }
  private async synthesize(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand) {
    const context = valueOf(await this.store.getCheckpoint({ runId: run.id, step: 'retrieval' }), 'retrieval'); const conversation = valueOf(await this.store.getCheckpoint({ runId: run.id, step: 'specialist:conversation' }), 'conversation'); const stakeholder = valueOf(await this.store.getCheckpoint({ runId: run.id, step: 'specialist:stakeholder' }), 'stakeholder'); const commercial = valueOf(await this.store.getCheckpoint({ runId: run.id, step: 'specialist:commercial' }), 'commercial');
    const existing = await this.store.getCheckpoint({ runId: run.id, step: 'strategy' }); const value = existing?.value ?? await this.services.strategy(run, { context, conversation, stakeholder, commercial }, lease.invocationId); const parsed = await this.services.validateDraft(value);
    if (existing === undefined) { const generationMetadata = generation(run, lease, 'strategy'); await this.store.saveCheckpoint({ runId: run.id, step: 'strategy', invocationId: lease.invocationId, invocationOwner: lease.owner, leaseToken: lease.leaseToken, logicalGenerationId: generationMetadata.logicalGenerationId, checkpoint: { status: 'completed', value: parsed, generation: generationMetadata } }); }
    await this.advance(run, lease, causal, 'synthesis_completed', 'synthesis', { status: 'completed' }, 'validate');
  }
  private async validate(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand) {
    const strategy = await this.store.getCheckpoint({ runId: run.id, step: 'strategy' }); const commercial = valueOf(await this.store.getCheckpoint({ runId: run.id, step: 'specialist:commercial' }), 'commercial'); const payload = assertApprovableBrief(await this.services.validateDraft(strategy?.value)); const requirement = decideApprovalRequirement(await this.services.approvalInput(run, payload, commercial)); const subjectHash = hashApprovalPayload(payload); const recommendationIds = payload.recommendedNextActions.actions.map((action, index) => `recommendation:${index}:${hashApprovalPayload(action).slice(0, 16)}`);
    if (requirement.entries.length > 0) { await this.store.awaitApproval({ runId: run.id, expectedVersion: run.version, invocationId: lease.invocationId, invocationOwner: lease.owner, leaseToken: lease.leaseToken, causalCommandId: causal.id, subject: { id: stableId('approval_subject', run.id, String(run.version + 1), subjectHash), runId: run.id, subjectHash, payload, sectionIds: SECTION_IDS, recommendationIds, citationIds: collectCitationIds(payload), policyTriggers: requirement.policyTriggers, entries: requirement.entries, quorumVersion: requirement.quorumVersion } }); return; }
    await this.store.commitStepAndEnqueueNext({ runId: run.id, expectedVersion: run.version, invocationId: lease.invocationId, invocationOwner: lease.owner, leaseToken: lease.leaseToken, causalCommandId: causal.id, event: 'validation_completed', checkpointStep: 'validation', checkpoint: { status: 'completed', subjectHash, payload }, nextCommand: workflowCommand(run.id, 'finalize', subjectHash, { subjectHash, payload }) });
  }
  private async finalize(run: WorkflowRun, lease: StepLease, causal: WorkflowCommand) {
    const payload = assertApprovableBrief(causal.payload.payload); const subjectHash = causal.payload.subjectHash; if (typeof subjectHash !== 'string' || hashApprovalPayload(payload) !== subjectHash) throw new DomainConflictError('Finalization payload hash mismatch'); await this.store.finalizeRun({ runId: run.id, expectedVersion: run.version, invocationId: lease.invocationId, invocationOwner: lease.owner, leaseToken: lease.leaseToken, causalCommandId: causal.id, subjectHash, payload, ...(typeof causal.payload.approvalSubjectId === 'string' ? { approvalSubjectId: causal.payload.approvalSubjectId } : {}) });
  }
}
