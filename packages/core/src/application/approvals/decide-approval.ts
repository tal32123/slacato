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

function citationIds(value: unknown): readonly string[] {
  const ids = new Set<string>();
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) { current.forEach(visit); return; }
    if (current === null || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    if (typeof record.id === 'string' && typeof record.evidenceId === 'string' && typeof record.locator === 'string') ids.add(record.id);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...ids].sort();
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
    const subject = await this.store.getApprovalSubject({ runId, approvalSubjectId: input.approvalSubjectId });
    if (subject === undefined) throw new DomainNotFoundError('approval subject');
    if (subject.subjectHash !== input.expectedSubjectHash) throw new DomainConflictError('Approval subject is stale');
    const entry = subject.entries.find((candidate) => candidate.id === input.entryId);
    if (entry === undefined || entry.category !== input.category) throw new DomainConflictError('Approval category does not match the required entry');
    if (!entry.eligibleAuthorities.includes(input.authority)) throw new AuthorizationDeniedError('Requested authority cannot satisfy this approval entry');
    const granted = await this.access.authoritiesFor({ actorId: input.actorId, opportunityId: run.opportunityId });
    if (!granted.includes(input.authority)) throw new AuthorizationDeniedError('Actor does not hold the requested approval authority');

    const alreadyApproved = new Set(subject.decisions.filter((decision) => decision.action !== 'reject').map((decision) => decision.entryId));
    if (entry.dependsOn.some((dependency) => !alreadyApproved.has(dependency))) throw new DomainConflictError('Underlying approval entries are incomplete');

    const originalPayload = assertApprovableBrief(subject.payload);
    const effectivePayload = subject.decisions[0] === undefined ? originalPayload : assertApprovableBrief(subject.decisions[0].approvedPayload);
    const approvedPayload: DealBrief = input.action === 'edit_and_approve' ? assertApprovableBrief(input.editedPayload) : effectivePayload;
    const approvedSubjectHash = hashApprovalPayload(approvedPayload);
    const originalSubjectHash = hashApprovalPayload(originalPayload);
    if (originalSubjectHash !== subject.subjectHash) throw new DomainConflictError('Persisted approval payload no longer matches its immutable hash');
    const allowedCitations = new Set(subject.citationIds);
    if (citationIds(approvedPayload).some((id) => !allowedCitations.has(id))) throw new DomainValidationError('Edited approval payload cites evidence outside the immutable subject');
    if (approvedPayload.confidenceAndReviewWarnings.overallConfidence < 0.7 && !subject.entries.some((candidate) => candidate.category === 'evidence_review')) {
      throw new DomainValidationError('Edited approval payload requires a human evidence review entry');
    }
    if (input.action === 'edit_and_approve' && subject.decisions.some((decision) => decision.approvedSubjectHash !== approvedSubjectHash)) {
      throw new DomainConflictError('An edit cannot rebind prior decisions to a different snapshot');
    }

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
      decidedAt
    } as const;
    const finalizationCommand = {
      id: `command_${crypto.randomUUID().replaceAll('-', '')}`,
      runId,
      type: 'process-deal-brief-step',
      payload: { step: 'finalize', approvalSubjectId: subject.id, subjectHash: approvedSubjectHash, payload: approvedPayload },
      idempotencyKey: `${subject.id}:finalize:${approvedSubjectHash}`
    } as const;
    const stored = await this.store.recordDecisionAndEnqueueFinalization({ runId, expectedVersion: input.expectedRunVersion,
      approvalSubjectId: subject.id, expectedSubjectHash: subject.subjectHash, entryId: entry.id, category: input.category,
      authority: input.authority, actorId: input.actorId as UserId, idempotencyKey: input.idempotencyKey, decision, finalizationCommand });
    return result(input, stored);
  }
}
