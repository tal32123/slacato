import { AuthorizationDeniedError, DomainConflictError, DomainNotFoundError, DomainValidationError } from '../../domain/shared/errors.js';
import type { RunId, UserId } from '../../domain/shared/ids.js';
import type { ApprovalAction, ApprovalDecisionStoreResult, WorkflowStore } from '../workflow/workflow-store.js';
import type { ApprovalAuthority, ApprovalCategory } from '../../domain/briefs/policy.js';
import type { DealBrief } from '../../domain/briefs/schema.js';
import type { DealBriefAccessControl } from '../briefs/workflow.js';
import { assertApprovableBrief, hashApprovalPayload } from '../briefs/workflow.js';

export type DecideApprovalCommand = Readonly<{
  runId: string;
  approvalSubjectId: string;
  expectedRunVersion: number;
  expectedSubjectHash: string;
  entryId: string;
  category: ApprovalCategory;
  authority: ApprovalAuthority;
  actorId: string;
  action: ApprovalAction;
  idempotencyKey: string;
  rationale?: string | undefined;
  editedPayload?: unknown;
}>;

export type ApprovalResult = Readonly<{
  status: 'awaiting_approval' | 'finalizing' | 'rejected';
  runVersion: number;
  approvalSubjectId: string;
  entryId: string;
  approvedSubjectHash: string;
  quorumSatisfied: boolean;
  replayed: boolean;
}>;

function citationBindings(value: unknown): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) { current.forEach(visit); return; }
    if (current === null || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    if (typeof record.id === 'string' && typeof record.evidenceId === 'string' && typeof record.locator === 'string') {
      const binding = hashApprovalPayload({ id: record.id, evidenceId: record.evidenceId, locator: record.locator });
      const existing = bindings.get(record.id);
      if (existing !== undefined && existing !== binding) throw new DomainValidationError('A citation ID is bound to conflicting evidence');
      bindings.set(record.id, binding);
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return bindings;
}

function result(input: DecideApprovalCommand, stored: ApprovalDecisionStoreResult): ApprovalResult {
  return {
    status: stored.rejected ? 'rejected' : stored.quorumSatisfied ? 'finalizing' : 'awaiting_approval',
    runVersion: stored.run.version,
    approvalSubjectId: input.approvalSubjectId,
    entryId: input.entryId,
    approvedSubjectHash: stored.approvedSubjectHash,
    quorumSatisfied: stored.quorumSatisfied,
    replayed: stored.replayed
  };
}

/** Records one authority decision against an immutable snapshot and advances only on complete quorum. */
export class DecideApproval {
  public constructor(private readonly store: WorkflowStore, private readonly access: DealBriefAccessControl) {}

  public async execute(input: DecideApprovalCommand): Promise<ApprovalResult> {
    if (!Number.isInteger(input.expectedRunVersion) || input.expectedRunVersion < 0) throw new DomainValidationError('Expected run version is invalid');
    if (input.idempotencyKey.trim().length === 0) throw new DomainValidationError('Decision idempotency key is required');
    if ((input.action === 'edit_and_approve' || input.action === 'reject') && (input.rationale?.trim().length ?? 0) === 0) {
      throw new DomainValidationError(`${input.action} requires rationale`);
    }
    if (input.action !== 'edit_and_approve' && input.editedPayload !== undefined) throw new DomainValidationError('Only edit-and-approve accepts an edited payload');
    if (input.action === 'edit_and_approve' && input.editedPayload === undefined) throw new DomainValidationError('Edit-and-approve requires an edited payload');

    const runId = input.runId as RunId;
    const run = await this.store.getRun(runId);
    if (run === undefined) throw new DomainNotFoundError('run');
    const granted = await this.access.authoritiesFor({ actorId: input.actorId, opportunityId: run.opportunityId });
    if (!granted.includes(input.authority)) {
      await this.access.recordOpaqueDenial({ type: 'approval_decision_denied', actorId: input.actorId, reason: 'forbidden' });
      throw new AuthorizationDeniedError('Approval decision denied');
    }
    const subject = await this.store.getApprovalSubject({ runId, approvalSubjectId: input.approvalSubjectId });
    if (subject === undefined || subject.supersededBySubjectId !== undefined) throw new DomainNotFoundError('approval subject');
    if (subject.subjectHash !== input.expectedSubjectHash) throw new DomainConflictError('Approval subject is stale');
    const entry = subject.entries.find((candidate) => candidate.id === input.entryId);
    if (entry === undefined || entry.category !== input.category) throw new DomainConflictError('Approval category does not match the required entry');
    if (!entry.eligibleAuthorities.includes(input.authority)) throw new AuthorizationDeniedError('Requested authority cannot satisfy this approval entry');

    const alreadyApproved = new Set(subject.decisions.filter((decision) => decision.action !== 'reject').map((decision) => decision.entryId));
    if (entry.dependsOn.some((dependency) => !alreadyApproved.has(dependency))) throw new DomainConflictError('Underlying approval entries are incomplete');
    const distinctCommercialQuorum = subject.entries.filter((candidate) => candidate.category === 'commercial_discount')
      .some((candidate) => candidate.eligibleAuthorities.includes('deal_desk'))
      && subject.entries.filter((candidate) => candidate.category === 'commercial_discount')
        .some((candidate) => candidate.eligibleAuthorities.includes('sales_leader'));
    if (distinctCommercialQuorum && subject.decisions.some((decision) => decision.actorId === input.actorId && decision.entryId !== entry.id)) {
      throw new AuthorizationDeniedError('Distinct approval actors are required for commercial quorum');
    }

    const originalPayload = assertApprovableBrief(subject.payload);
    const effectivePayload = subject.decisions[0] === undefined ? originalPayload : assertApprovableBrief(subject.decisions[0].approvedPayload);
    const approvedPayload: DealBrief = input.action === 'edit_and_approve' ? assertApprovableBrief(input.editedPayload) : effectivePayload;
    const approvedSubjectHash = hashApprovalPayload(approvedPayload);
    const originalSubjectHash = hashApprovalPayload(originalPayload);
    if (originalSubjectHash !== subject.subjectHash) throw new DomainConflictError('Persisted approval payload no longer matches its immutable hash');
    const originalBindings = citationBindings(originalPayload);
    for (const [id, binding] of citationBindings(approvedPayload)) {
      if (originalBindings.get(id) !== binding) throw new DomainValidationError('Edited approval payload changed an immutable citation binding');
    }
    const editedRequirement = input.action === 'edit_and_approve'
      ? await this.access.validateApprovalEdit({ actorId: input.actorId, opportunityId: run.opportunityId, runId: run.id, payload: approvedPayload })
      : undefined;

    const requestHash = hashApprovalPayload({
      runId: input.runId, approvalSubjectId: input.approvalSubjectId, expectedRunVersion: input.expectedRunVersion,
      expectedSubjectHash: input.expectedSubjectHash, entryId: input.entryId, category: input.category, authority: input.authority,
      actorId: input.actorId, action: input.action, idempotencyKey: input.idempotencyKey,
      rationale: input.rationale?.trim() ?? null, editedPayload: input.editedPayload ?? null
    });
    const decidedAt = new Date().toISOString();
    const decision = {
      action: input.action,
      entryId: entry.id,
      category: input.category,
      authority: input.authority,
      actorId: input.actorId as UserId,
      originalPayload,
      approvedPayload,
      approvedSubjectHash,
      ...(input.action === 'edit_and_approve' ? {
        editedPayload: approvedPayload,
        diff: { originalSubjectHash, approvedSubjectHash, changed: originalSubjectHash !== approvedSubjectHash }
      } : {}),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale.trim() }),
      requestHash,
      decidedAt
    } as const;
    if (input.action === 'edit_and_approve' && editedRequirement !== undefined) {
      const nextSubjectId = `approval_subject_${hashApprovalPayload({ runId, prior: subject.id, approvedSubjectHash, requestHash })}`;
      const replaced = await this.store.replaceApprovalSubject({
        runId, expectedVersion: input.expectedRunVersion, priorSubjectId: subject.id, priorDecision: decision,
        idempotencyKey: input.idempotencyKey, requestHash,
        subject: {
          id: nextSubjectId, runId, subjectHash: approvedSubjectHash, payload: approvedPayload,
          sectionIds: subject.sectionIds,
          recommendationIds: approvedPayload.recommendedNextActions.actions.map((action, index) => `recommendation:${index}:${hashApprovalPayload(action).slice(0, 16)}`),
          citationIds: [...citationBindings(approvedPayload).keys()].sort(),
          policyTriggers: editedRequirement.policyTriggers,
          entries: editedRequirement.entries.length === 0 ? [entry] : editedRequirement.entries,
          quorumVersion: editedRequirement.quorumVersion
        }
      });
      return { status: 'awaiting_approval', runVersion: replaced.run.version, approvalSubjectId: replaced.subject.id, entryId: input.entryId,
        approvedSubjectHash, quorumSatisfied: false, replayed: replaced.replayed };
    }
    const finalizationCommand = {
      id: `command_${crypto.randomUUID().replaceAll('-', '')}`,
      runId,
      type: 'process-deal-brief-step',
      payload: { step: 'finalize', approvalSubjectId: subject.id, subjectHash: approvedSubjectHash, payload: approvedPayload },
      idempotencyKey: `${subject.id}:finalize:${approvedSubjectHash}`
    } as const;
    const stored = await this.store.recordDecisionAndEnqueueFinalization({ runId, expectedVersion: input.expectedRunVersion,
      approvalSubjectId: subject.id, expectedSubjectHash: subject.subjectHash, entryId: entry.id, category: input.category,
      authority: input.authority, actorId: input.actorId as UserId, idempotencyKey: input.idempotencyKey, requestHash, decision, finalizationCommand });
    return result(input, stored);
  }
}
