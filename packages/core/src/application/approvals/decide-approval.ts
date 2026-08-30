import type { ApprovalAuthority, ApprovalCategory } from '../../domain/briefs/policy.js';
import { collectDealBriefReferences } from '../../domain/briefs/references.js';
import type { DealBrief } from '../../domain/briefs/schema.js';
import {
  AuthorizationDeniedError,
  DomainConflictError,
  DomainNotFoundError,
  DomainValidationError
} from '../../domain/shared/errors.js';
import type { RunId, UserId } from '../../domain/shared/ids.js';
import type { DealBriefAccessControl } from '../briefs/workflow.js';
import { assertApprovableBrief, hashApprovalPayload } from '../briefs/workflow.js';
import type {
  ApprovalAction,
  ApprovalDecisionStoreResult,
  WorkflowStore
} from '../workflow/workflow-store.js';

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

/** Converts the persisted decision outcome into the approval result returned to callers. */
function toApprovalResult(
  input: DecideApprovalCommand,
  stored: ApprovalDecisionStoreResult
): ApprovalResult {
  return {
    status: stored.rejected
      ? 'rejected'
      : stored.quorumSatisfied
        ? 'finalizing'
        : 'awaiting_approval',
    runVersion: stored.run.version,
    approvalSubjectId: input.approvalSubjectId,
    entryId: input.entryId,
    approvedSubjectHash: stored.approvedSubjectHash,
    quorumSatisfied: stored.quorumSatisfied,
    replayed: stored.replayed
  };
}
/** Summarizes approval edits as changed review fields and brief sections. */
function structuredApprovalDiff(
  before: DealBrief,
  after: DealBrief
): Readonly<Record<string, unknown>> {
  const fields = [
    {
      field: 'executive_summary',
      before: before.executiveSummary.narrative,
      after: after.executiveSummary.narrative
    },
    {
      field: 'negotiation_state',
      before: before.negotiationState.currentState,
      after: after.negotiationState.currentState
    },
    {
      field: 'overall_confidence',
      before: String(before.confidenceAndReviewWarnings.overallConfidence),
      after: String(after.confidenceAndReviewWarnings.overallConfidence)
    }
  ].filter((field) => field.before !== field.after);
  const sections = [
    ['deal_snapshot', before.dealSnapshot, after.dealSnapshot],
    ['executive_summary', before.executiveSummary, after.executiveSummary],
    [
      'buyer_goals_and_business_drivers',
      before.buyerGoalsAndBusinessDrivers,
      after.buyerGoalsAndBusinessDrivers
    ],
    ['stakeholder_map', before.stakeholderMap, after.stakeholderMap],
    ['negotiation_state', before.negotiationState, after.negotiationState],
    ['recommended_next_actions', before.recommendedNextActions, after.recommendedNextActions],
    ['missing_information', before.missingInformation, after.missingInformation],
    ['source_evidence', before.sourceEvidence, after.sourceEvidence],
    [
      'confidence_and_review_warnings',
      before.confidenceAndReviewWarnings,
      after.confidenceAndReviewWarnings
    ]
  ] as const;
  return {
    changed: hashApprovalPayload(before) !== hashApprovalPayload(after),
    fields,
    changedSections: sections
      .filter(([, prior, next]) => hashApprovalPayload(prior) !== hashApprovalPayload(next))
      .map(([section]) => section)
  };
}

/** Records one authority decision against an immutable snapshot and advances only on complete quorum. */
export class DecideApproval {
  /** Provides the workflow store and access policy used to decide approvals. */
  public constructor(
    private readonly store: WorkflowStore,
    private readonly access: DealBriefAccessControl
  ) {}

  /** Validates and records one decision, then returns the resulting approval state. */
  public async execute(input: DecideApprovalCommand): Promise<ApprovalResult> {
    if (!Number.isInteger(input.expectedRunVersion) || input.expectedRunVersion < 0)
      throw new DomainValidationError('Expected run version is invalid');
    if (input.idempotencyKey.trim().length === 0)
      throw new DomainValidationError('Decision idempotency key is required');
    if (
      (input.action === 'edit_and_approve' || input.action === 'reject') &&
      (input.rationale?.trim().length ?? 0) === 0
    ) {
      throw new DomainValidationError(`${input.action} requires rationale`);
    }
    if (input.action !== 'edit_and_approve' && input.editedPayload !== undefined)
      throw new DomainValidationError('Only edit-and-approve accepts an edited payload');
    if (input.action === 'edit_and_approve' && input.editedPayload === undefined)
      throw new DomainValidationError('Edit-and-approve requires an edited payload');

    const runId = input.runId as RunId;
    const run = await this.store.getRun(runId);
    if (run === undefined) throw new DomainNotFoundError('run');
    const granted = await this.access.authoritiesFor({
      actorId: input.actorId,
      opportunityId: run.opportunityId
    });
    if (!granted.includes(input.authority)) {
      await this.access.recordOpaqueDenial({
        type: 'approval_decision_denied',
        actorId: input.actorId,
        reason: 'forbidden'
      });
      throw new AuthorizationDeniedError('Approval decision denied');
    }
    const subject = await this.store.getApprovalSubject({
      runId,
      approvalSubjectId: input.approvalSubjectId
    });
    const entry = subject?.entries.find((candidate) => candidate.id === input.entryId);
    if (subject === undefined || entry === undefined)
      throw new DomainNotFoundError('approval subject');
    if (!entry.eligibleAuthorities.includes(input.authority)) {
      await this.access.recordOpaqueDenial({
        type: 'approval_decision_denied',
        actorId: input.actorId,
        reason: 'forbidden'
      });
      throw new AuthorizationDeniedError('Approval decision denied');
    }
    const requestHash = hashApprovalPayload({
      runId: input.runId,
      approvalSubjectId: input.approvalSubjectId,
      expectedRunVersion: input.expectedRunVersion,
      expectedSubjectHash: input.expectedSubjectHash,
      entryId: input.entryId,
      category: input.category,
      authority: input.authority,
      actorId: input.actorId,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      rationale: input.rationale?.trim() ?? null,
      editedPayload: input.editedPayload ?? null
    });
    const replay = await this.store.findDecisionByIdempotencyKey({
      idempotencyKey: input.idempotencyKey,
      requestHash
    });
    if (replay !== undefined) {
      return {
        status: replay.rejected
          ? 'rejected'
          : replay.quorumSatisfied
            ? 'finalizing'
            : 'awaiting_approval',
        runVersion: replay.run.version,
        approvalSubjectId: replay.approvalSubjectId,
        entryId: replay.entryId,
        approvedSubjectHash: replay.approvedSubjectHash,
        quorumSatisfied: replay.quorumSatisfied,
        replayed: true
      };
    }
    if (subject.supersededBySubjectId !== undefined)
      throw new DomainNotFoundError('approval subject');
    if (subject.subjectHash !== input.expectedSubjectHash)
      throw new DomainConflictError('Approval subject is stale');
    if (entry.category !== input.category)
      throw new DomainConflictError('Approval category does not match the required entry');

    const alreadyApproved = new Set(
      subject.decisions
        .filter((decision) => decision.action !== 'reject')
        .map((decision) => decision.entryId)
    );
    if (entry.dependsOn.some((dependency) => !alreadyApproved.has(dependency)))
      throw new DomainConflictError('Underlying approval entries are incomplete');
    const oppositeCommercialAuthority =
      input.authority === 'deal_desk'
        ? 'sales_leader'
        : input.authority === 'sales_leader'
          ? 'deal_desk'
          : undefined;
    if (
      entry.category === 'commercial_discount' &&
      oppositeCommercialAuthority !== undefined &&
      subject.decisions.some(
        (decision) =>
          decision.category === 'commercial_discount' &&
          decision.authority === oppositeCommercialAuthority &&
          decision.actorId === input.actorId
      )
    ) {
      throw new AuthorizationDeniedError(
        'Distinct approval actors are required for commercial quorum'
      );
    }

    const originalPayload = assertApprovableBrief(subject.payload);
    const effectivePayload =
      subject.decisions[0] === undefined
        ? originalPayload
        : assertApprovableBrief(subject.decisions[0].approvedPayload);
    const approvedPayload: DealBrief =
      input.action === 'edit_and_approve'
        ? assertApprovableBrief(input.editedPayload)
        : effectivePayload;
    const approvedSubjectHash = hashApprovalPayload(approvedPayload);
    const originalSubjectHash = hashApprovalPayload(originalPayload);
    if (originalSubjectHash !== subject.subjectHash)
      throw new DomainConflictError(
        'Persisted approval payload no longer matches its immutable hash'
      );
    const originalReferences = collectDealBriefReferences(originalPayload);
    const approvedReferences = collectDealBriefReferences(approvedPayload);
    const originalCitationsById = new Map(
      originalReferences.citations.map((citation) => [citation.id, citation])
    );
    for (const citation of approvedReferences.citations) {
      const originalCitation = originalCitationsById.get(citation.id);
      if (
        originalCitation === undefined ||
        originalCitation.evidenceId !== citation.evidenceId ||
        originalCitation.locator !== citation.locator
      ) {
        throw new DomainValidationError(
          'Edited approval payload changed an immutable citation binding'
        );
      }
    }
    const editedRequirement =
      input.action === 'edit_and_approve'
        ? await this.access.validateApprovalEdit({
            actorId: input.actorId,
            opportunityId: run.opportunityId,
            runId: run.id,
            originalPayload,
            payload: approvedPayload
          })
        : undefined;

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
      ...(input.action === 'edit_and_approve'
        ? {
            editedPayload: approvedPayload,
            diff: {
              originalSubjectHash,
              approvedSubjectHash,
              ...structuredApprovalDiff(originalPayload, approvedPayload)
            }
          }
        : {}),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale.trim() }),
      requestHash,
      decidedAt
    } as const;
    if (input.action === 'edit_and_approve' && editedRequirement !== undefined) {
      const nextSubjectId = `approval_subject_${hashApprovalPayload({ runId, prior: subject.id, approvedSubjectHash, requestHash })}`;
      const replaced = await this.store.replaceApprovalSubject({
        runId,
        expectedVersion: input.expectedRunVersion,
        priorSubjectId: subject.id,
        priorDecision: decision,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        subject: {
          id: nextSubjectId,
          runId,
          subjectHash: approvedSubjectHash,
          payload: approvedPayload,
          sectionIds: subject.sectionIds,
          recommendationIds: approvedPayload.recommendedNextActions.actions.map(
            (action, index) => `recommendation:${index}:${hashApprovalPayload(action).slice(0, 16)}`
          ),
          citationIds: approvedReferences.citations.map((citation) => citation.id),
          policyTriggers: editedRequirement.policyTriggers,
          entries: editedRequirement.entries.length === 0 ? [entry] : editedRequirement.entries,
          quorumVersion: editedRequirement.quorumVersion
        }
      });
      return {
        status: 'awaiting_approval',
        runVersion: replaced.run.version,
        approvalSubjectId: replaced.subject.id,
        entryId: input.entryId,
        approvedSubjectHash,
        quorumSatisfied: false,
        replayed: replaced.replayed
      };
    }
    const finalizationCommand = {
      id: `command_${crypto.randomUUID().replaceAll('-', '')}`,
      runId,
      type: 'process-deal-brief-step',
      payload: {
        step: 'finalize',
        approvalSubjectId: subject.id,
        subjectHash: approvedSubjectHash,
        payload: approvedPayload
      },
      idempotencyKey: `${subject.id}:finalize:${approvedSubjectHash}`
    } as const;
    const stored = await this.store.recordDecisionAndEnqueueFinalization({
      runId,
      expectedVersion: input.expectedRunVersion,
      approvalSubjectId: subject.id,
      expectedSubjectHash: subject.subjectHash,
      entryId: entry.id,
      category: input.category,
      authority: input.authority,
      actorId: input.actorId as UserId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      decision,
      finalizationCommand
    });
    return toApprovalResult(input, stored);
  }
}
