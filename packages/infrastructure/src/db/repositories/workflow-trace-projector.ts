import type { TraceSpan } from '@slacato/contracts';
import {
  type ApprovalAuthority,
  type ApprovalCategory,
  type ApprovalRequirementEntry,
  dealBriefSchema,
  hashApprovalPayload
} from '@slacato/core';
import { z } from 'zod';

const unknownRecordSchema = z.record(z.string(), z.unknown());
const partialFailureReasonSchema = z.enum([
  'conversation_unavailable',
  'stakeholder_unavailable',
  'commercial_unavailable',
  'strategy_unavailable'
]);
const failureReasonCodeSchema = z.enum([
  'conversation_unavailable',
  'stakeholder_unavailable',
  'commercial_unavailable',
  'strategy_unavailable',
  'commercial_specialist_failed',
  'strategy_generation_failed',
  'draft_validation_failed',
  'workflow_failed'
]);

const failureOperations = {
  conversation_unavailable: 'conversation',
  stakeholder_unavailable: 'stakeholder',
  commercial_unavailable: 'commercial',
  strategy_unavailable: 'strategy',
  commercial_specialist_failed: 'commercial',
  strategy_generation_failed: 'strategy',
  draft_validation_failed: 'strategy',
  workflow_failed: 'strategy'
} as const;

type FailureReasonCode = z.infer<typeof failureReasonCodeSchema>;
type TraceKind = TraceSpan['kind'];
type TraceSpanFor<K extends TraceKind> = Extract<TraceSpan, { kind: K }>;

type LatestTraceParentCandidate = Readonly<{
  kinds: readonly TraceKind[];
  step?: string;
}>;

export type TraceParentReference =
  | Readonly<{ type: 'direct'; spanId: string }>
  | Readonly<{ type: 'if_present'; spanId: string }>
  | Readonly<{ type: 'latest'; candidates: readonly LatestTraceParentCandidate[] }>;

type ProjectedTraceSpanFor<K extends TraceKind> = Readonly<{
  traceId: string;
  spanId: string;
  runId: string;
  step: string;
  attempt: number;
  kind: K;
  status: TraceSpanFor<K>['status'];
  data: TraceSpanFor<K>['data'];
  parent?: TraceParentReference;
}>;

export type ProjectedTraceSpan = {
  [K in TraceKind]: ProjectedTraceSpanFor<K>;
}[TraceKind];

export type GenerationAttemptProjection = Readonly<{
  runId: string;
  id: string;
  invocationId: string;
  logicalGenerationId: string;
  operation: string;
  ordinal: number;
  status: 'completed' | 'failed';
  provider: string;
  model: string;
  outputMode: 'native_schema' | 'prompted_json' | null;
  validationAttempts: number;
  possibleDuplicate: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}>;

export type PersistedGenerationAttempt = Readonly<{
  id: string;
  logicalGenerationId: string;
  ordinal: number;
  provider: string;
  model: string;
  outputMode: 'native_schema' | 'prompted_json' | null;
  validationAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  status: string;
  possibleDuplicate: boolean;
}>;

type ApprovalSubjectTraceInput = Readonly<{
  id: string;
  subjectHash: string;
  recommendationIds: readonly string[];
  policyTriggers: readonly string[];
  quorumVersion: string;
  entries: readonly ApprovalRequirementEntry[];
}>;

type WorkflowTraceProjectionInput =
  | Readonly<{
      type: 'run_started';
      runId: string;
      opportunityId: string;
      requestedBy: string;
    }>
  | Readonly<{
      type: 'generation_checkpoint';
      runId: string;
      step: string;
      invocationId: string;
      logicalGenerationId?: string;
      checkpoint: Readonly<Record<string, unknown>>;
      persistedAttempts: readonly PersistedGenerationAttempt[];
    }>
  | Readonly<{
      type: 'retrieval_completed';
      runId: string;
      checkpoint: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      type: 'validation_completed';
      runId: string;
      version: number;
      checkpoint: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      type: 'approval_required';
      runId: string;
      subject: ApprovalSubjectTraceInput;
    }>
  | Readonly<{
      type: 'approval_decided';
      runId: string;
      version: number;
      approvalSubjectId: string;
      subjectHash: string;
      entryId: string;
      category: ApprovalCategory;
      authority: ApprovalAuthority;
      decision: 'approved' | 'rejected';
    }>
  | Readonly<{
      type: 'approval_subject_replaced';
      runId: string;
      version: number;
      priorSubjectId: string;
      priorDecision: Readonly<{
        subjectHash: string;
        entryId: string;
        category: ApprovalCategory;
        authority: ApprovalAuthority;
      }>;
      subject: ApprovalSubjectTraceInput;
    }>
  | Readonly<{
      type: 'finalized';
      runId: string;
      version: number;
      subjectHash: string;
    }>
  | Readonly<{
      type: 'failed';
      runId: string;
      version: number;
      reason: string;
    }>;

export type WorkflowTraceProjection = Readonly<{
  spans: readonly ProjectedTraceSpan[];
  generationAttempt?: GenerationAttemptProjection;
  failureReasonCode?: FailureReasonCode;
}>;

/** Converts one completed workflow action into the validated, persistence-neutral trace records it implies. */
export function projectWorkflowTrace(input: WorkflowTraceProjectionInput): WorkflowTraceProjection {
  switch (input.type) {
    case 'run_started':
      return {
        spans: [
          projectSpan({
            runId: input.runId,
            kind: 'authorization_lookup',
            discriminator: 'start',
            step: 'authorization',
            data: {
              decision: 'allowed',
              correlationHash: hashApprovalPayload({
                runId: input.runId,
                opportunityId: input.opportunityId,
                requestedBy: input.requestedBy
              }),
              readKinds: ['opportunity', 'account', 'requester', 'permissions'],
              readCount: 4
            }
          })
        ]
      };
    case 'generation_checkpoint':
      return projectGenerationCheckpoint(input);
    case 'retrieval_completed':
      return projectRetrieval(input.runId, input.checkpoint);
    case 'validation_completed':
      return projectValidation(input.runId, input.version, input.checkpoint);
    case 'approval_required':
      return { spans: projectApprovalSubject(input.runId, input.subject) };
    case 'approval_decided':
      return { spans: [projectApprovalDecision(input)] };
    case 'approval_subject_replaced': {
      const priorDecision = projectApprovalDecision(
        {
          type: 'approval_decided',
          runId: input.runId,
          version: input.version,
          approvalSubjectId: input.priorSubjectId,
          subjectHash: input.priorDecision.subjectHash,
          entryId: input.priorDecision.entryId,
          category: input.priorDecision.category,
          authority: input.priorDecision.authority,
          decision: 'approved'
        },
        'edited'
      );
      return { spans: [priorDecision, ...projectApprovalSubject(input.runId, input.subject)] };
    }
    case 'finalized':
      return {
        spans: [
          projectSpan({
            runId: input.runId,
            kind: 'finalization',
            discriminator: `${input.subjectHash}:${input.version}`,
            step: 'finalization',
            parent: {
              type: 'latest',
              candidates: [{ kinds: ['approval_decision', 'strategy_attempt'] }]
            },
            data: { decision: 'completed', artifactHash: input.subjectHash }
          })
        ]
      };
    case 'failed':
      return projectFailure(input);
  }
}

/** Builds deterministic span identifiers while preserving the data type associated with each trace kind. */
function projectSpan<K extends TraceKind>(
  input: Readonly<{
    runId: string;
    kind: K;
    discriminator: string;
    step: string;
    attempt?: number;
    status?: TraceSpanFor<K>['status'];
    parent?: TraceParentReference;
    data: TraceSpanFor<K>['data'];
  }>
): ProjectedTraceSpanFor<K> {
  return {
    traceId: `trace_${hashApprovalPayload(input.runId)}`,
    spanId: traceSpanId(input.runId, input.kind, input.discriminator),
    runId: input.runId,
    step: input.step,
    attempt: input.attempt ?? 1,
    kind: input.kind,
    status: input.status ?? 'completed',
    data: input.data,
    ...(input.parent === undefined ? {} : { parent: input.parent })
  };
}

/** Derives the stable identifier used to make trace persistence idempotent. */
function traceSpanId(runId: string, kind: TraceKind, discriminator: string): string {
  return `span_${hashApprovalPayload({ runId, kind, discriminator })}`;
}

/** Projects model, validation, guardrail, usage, repair, and degradation spans from a durable generation attempt. */
function projectGenerationCheckpoint(
  input: Extract<WorkflowTraceProjectionInput, { type: 'generation_checkpoint' }>
): WorkflowTraceProjection {
  if (
    input.logicalGenerationId === undefined ||
    (!input.step.startsWith('specialist:') && !input.step.startsWith('strategy'))
  ) {
    return { spans: [] };
  }

  const operation = input.step.startsWith('specialist:')
    ? input.step.slice('specialist:'.length)
    : 'strategy';
  const kind: 'specialist_attempt' | 'strategy_attempt' = input.step.startsWith('specialist:')
    ? 'specialist_attempt'
    : 'strategy_attempt';
  const attemptStatus =
    input.checkpoint.status === 'degraded'
      ? 'degraded'
      : input.checkpoint.status === 'failed'
        ? 'failed'
        : 'completed';
  const generationAttempt =
    input.persistedAttempts.length === 0
      ? projectFallbackGenerationAttempt(input, operation, attemptStatus)
      : undefined;
  const attempts = generationAttempt === undefined ? input.persistedAttempts : [generationAttempt];
  const attemptSpan = projectSpan({
    runId: input.runId,
    kind,
    discriminator: input.step,
    step: operation,
    status: attemptStatus,
    parent: {
      type: 'if_present',
      spanId: traceSpanId(input.runId, 'evidence_retrieval', 'retrieval')
    },
    data: { operation, logicalGenerationId: input.logicalGenerationId }
  });
  const spans: ProjectedTraceSpan[] = [attemptSpan];

  for (const attempt of attempts) {
    const failed = attempt.status === 'failed';
    const modelSpan = projectSpan({
      runId: input.runId,
      kind: 'model_call',
      discriminator: `${input.step}:model:${attempt.id}`,
      step: operation,
      attempt: attempt.ordinal,
      status: failed ? 'failed' : 'completed',
      parent: { type: 'direct', spanId: attemptSpan.spanId },
      data: {
        durableAttemptId: attempt.id,
        logicalGenerationId: attempt.logicalGenerationId,
        ordinal: attempt.ordinal,
        provider: attempt.provider,
        model: attempt.model,
        parametersHash: hashApprovalPayload({
          provider: attempt.provider,
          model: attempt.model,
          operation,
          outputMode: attempt.outputMode
        }),
        outputMode: attempt.outputMode,
        possibleDuplicate: attempt.possibleDuplicate
      }
    });
    spans.push(
      modelSpan,
      projectSpan({
        runId: input.runId,
        kind: 'validation',
        discriminator: `${input.step}:validation:${attempt.id}`,
        step: operation,
        attempt: attempt.ordinal,
        status: failed ? 'failed' : 'completed',
        parent: { type: 'direct', spanId: modelSpan.spanId },
        data: {
          decision: failed ? 'rejected' : 'accepted',
          validationAttempts: attempt.validationAttempts
        }
      }),
      projectSpan({
        runId: input.runId,
        kind: 'guardrail',
        discriminator: `${input.step}:guardrail:${attempt.id}`,
        step: operation,
        attempt: attempt.ordinal,
        parent: { type: 'direct', spanId: modelSpan.spanId },
        data: { decision: failed ? 'blocked' : 'passed' }
      }),
      projectSpan({
        runId: input.runId,
        kind: 'usage',
        discriminator: `${input.step}:usage:${attempt.id}`,
        step: operation,
        attempt: attempt.ordinal,
        parent: { type: 'direct', spanId: modelSpan.spanId },
        data: { inputTokens: attempt.inputTokens ?? 0, outputTokens: attempt.outputTokens ?? 0 }
      })
    );
    if (attempt.validationAttempts > 0) {
      spans.push(
        projectSpan({
          runId: input.runId,
          kind: 'repair',
          discriminator: `${input.step}:repair:${attempt.id}`,
          step: operation,
          attempt: attempt.ordinal,
          parent: { type: 'direct', spanId: modelSpan.spanId },
          data: { attempts: attempt.validationAttempts, decision: 'validated' }
        })
      );
    }
  }
  if (attemptStatus === 'degraded') {
    spans.push(
      projectSpan({
        runId: input.runId,
        kind: 'partial_failure',
        discriminator: `${input.step}:partial`,
        step: operation,
        status: 'degraded',
        parent: { type: 'direct', spanId: attemptSpan.spanId },
        data: {
          decision: 'partial',
          reasonCode: partialFailureReasonSchema.parse(`${operation}_unavailable`)
        }
      })
    );
  }
  return { spans, ...(generationAttempt === undefined ? {} : { generationAttempt }) };
}

/** Normalizes optional checkpoint metadata into the durable fallback attempt used by trace projection. */
function projectFallbackGenerationAttempt(
  input: Extract<WorkflowTraceProjectionInput, { type: 'generation_checkpoint' }>,
  operation: string,
  attemptStatus: TraceSpan['status']
): GenerationAttemptProjection {
  const generation = unknownRecordSchema.safeParse(input.checkpoint.generation);
  const metadata = generation.success ? generation.data : {};
  const provider = z.string().safeParse(metadata.provider);
  const model = z.string().safeParse(metadata.model);
  const possibleDuplicate = z.boolean().safeParse(metadata.possibleDuplicate);
  const logicalGenerationId = input.logicalGenerationId;
  if (logicalGenerationId === undefined)
    throw new Error('Generation projection requires a logical generation ID');
  return {
    runId: input.runId,
    id: `attempt_${hashApprovalPayload({ runId: input.runId, logicalGenerationId, operation, ordinal: 1 })}`,
    invocationId: input.invocationId,
    logicalGenerationId,
    operation,
    ordinal: 1,
    status: attemptStatus === 'failed' ? 'failed' : 'completed',
    provider: provider.success ? provider.data : 'unknown',
    model: model.success ? model.data : 'unknown',
    outputMode: null,
    validationAttempts: 0,
    possibleDuplicate: possibleDuplicate.success && possibleDuplicate.data,
    inputTokens: 0,
    outputTokens: 0
  };
}

/** Extracts only schema-checked evidence identifiers and scores from a retrieval checkpoint. */
function projectRetrieval(
  runId: string,
  checkpoint: Readonly<Record<string, unknown>>
): WorkflowTraceProjection {
  const value = unknownRecordSchema.safeParse(checkpoint.value);
  const evidence = value.success && Array.isArray(value.data.evidence) ? value.data.evidence : [];
  const resultIds: string[] = [];
  const scores: number[] = [];
  for (const candidate of evidence) {
    const record = unknownRecordSchema.safeParse(candidate);
    if (!record.success) continue;
    const evidenceId = z.string().safeParse(record.data.evidenceId);
    const score = z.number().finite().safeParse(record.data.score);
    if (evidenceId.success) resultIds.push(evidenceId.data);
    if (score.success) scores.push(score.data);
  }
  return {
    spans: [
      projectSpan({
        runId,
        kind: 'evidence_retrieval',
        discriminator: 'retrieval',
        step: 'retrieval',
        parent: { type: 'if_present', spanId: traceSpanId(runId, 'authorization_lookup', 'start') },
        data: { resultIds, scores, evidenceCount: resultIds.length }
      })
    ]
  };
}

/** Projects validation policy and recommendation spans from a checkpoint without trusting its payload shape. */
function projectValidation(
  runId: string,
  version: number,
  checkpoint: Readonly<Record<string, unknown>>
): WorkflowTraceProjection {
  const parsed = dealBriefSchema.safeParse(checkpoint.payload);
  const recommendationIds = parsed.success
    ? parsed.data.recommendedNextActions.actions.map(
        (action, index) => `recommendation:${index}:${hashApprovalPayload(action).slice(0, 16)}`
      )
    : [];
  const subjectHash =
    typeof checkpoint.subjectHash === 'string'
      ? checkpoint.subjectHash
      : hashApprovalPayload(checkpoint);
  return {
    spans: projectPolicyAndRecommendations({
      runId,
      discriminator: `validation:${version}`,
      subjectHash,
      recommendationIds,
      decision: 'no_approval_required',
      policyHash: hashApprovalPayload({ decision: 'no_approval_required', subjectHash })
    })
  };
}

/** Projects policy, recommendation, and requirement spans for an approval subject. */
function projectApprovalSubject(
  runId: string,
  subject: ApprovalSubjectTraceInput
): readonly ProjectedTraceSpan[] {
  const policySpans = projectPolicyAndRecommendations({
    runId,
    discriminator: subject.id,
    subjectHash: subject.subjectHash,
    recommendationIds: subject.recommendationIds,
    decision: 'approval_required',
    policyHash: hashApprovalPayload({
      policyTriggers: subject.policyTriggers,
      quorumVersion: subject.quorumVersion
    })
  });
  const policySpan = policySpans[0];
  if (policySpan === undefined) return [];
  return [
    ...policySpans,
    ...subject.entries.map((entry) =>
      projectSpan({
        runId,
        kind: 'approval_requirement',
        discriminator: `${subject.id}:${entry.id}`,
        step: 'approval',
        parent: { type: 'direct', spanId: policySpan.spanId },
        data: {
          subjectHash: subject.subjectHash,
          entryId: entry.id,
          category: entry.category,
          authorities: [...entry.eligibleAuthorities],
          policyHash: hashApprovalPayload(entry.policyTriggers)
        }
      })
    )
  ];
}

/** Projects the policy decision and its sibling recommendation span. */
function projectPolicyAndRecommendations(
  input: Readonly<{
    runId: string;
    discriminator: string;
    subjectHash: string;
    recommendationIds: readonly string[];
    decision: 'approval_required' | 'no_approval_required';
    policyHash: string;
  }>
): readonly ProjectedTraceSpan[] {
  const parent: TraceParentReference = {
    type: 'latest',
    candidates: [{ kinds: ['strategy_attempt'] }]
  };
  return [
    projectSpan({
      runId: input.runId,
      kind: 'policy_decision',
      discriminator: `${input.discriminator}:policy`,
      step: 'policy',
      parent,
      data: {
        decision: input.decision,
        policyHash: input.policyHash,
        subjectHash: input.subjectHash
      }
    }),
    projectSpan({
      runId: input.runId,
      kind: 'recommendation',
      discriminator: `${input.discriminator}:recommendations`,
      step: 'recommendation',
      parent,
      data: { recommendationIds: [...input.recommendationIds] }
    })
  ];
}

/** Projects an approval decision beneath its deterministic requirement span when that span exists. */
function projectApprovalDecision(
  input: Extract<WorkflowTraceProjectionInput, { type: 'approval_decided' }>,
  decision: 'approved' | 'rejected' | 'edited' = input.decision
): ProjectedTraceSpan {
  return projectSpan({
    runId: input.runId,
    kind: 'approval_decision',
    discriminator: `${input.approvalSubjectId}:${input.entryId}:${input.version}`,
    step: 'approval',
    parent: {
      type: 'if_present',
      spanId: traceSpanId(
        input.runId,
        'approval_requirement',
        `${input.approvalSubjectId}:${input.entryId}`
      )
    },
    data: {
      subjectHash: input.subjectHash,
      entryId: input.entryId,
      category: input.category,
      authority: input.authority,
      decision
    }
  });
}

/** Projects the failed attempt and terminal failure spans with the same parent fallback order as the workflow. */
function projectFailure(
  input: Extract<WorkflowTraceProjectionInput, { type: 'failed' }>
): WorkflowTraceProjection {
  const reasonCode = failureReasonCode(input.reason);
  const operation = failureOperations[reasonCode];
  const attemptKind: 'strategy_attempt' | 'specialist_attempt' =
    operation === 'strategy' ? 'strategy_attempt' : 'specialist_attempt';
  const attemptSpan = projectSpan({
    runId: input.runId,
    kind: attemptKind,
    discriminator: `${operation}:failed:${reasonCode}:${input.version}`,
    step: operation,
    status: 'failed',
    parent: {
      type: 'latest',
      candidates: [
        { kinds: [attemptKind], step: operation },
        { kinds: ['evidence_retrieval', 'authorization_lookup'] }
      ]
    },
    data: {
      operation,
      logicalGenerationId: `failed_${hashApprovalPayload({ runId: input.runId, operation, reasonCode, version: input.version })}`
    }
  });
  return {
    failureReasonCode: reasonCode,
    spans: [
      attemptSpan,
      projectSpan({
        runId: input.runId,
        kind: 'fatal_failure',
        discriminator: `${reasonCode}:${input.version}`,
        step: operation,
        status: 'failed',
        parent: { type: 'direct', spanId: attemptSpan.spanId },
        data: { decision: 'fatal', reasonCode }
      })
    ]
  };
}

/** Maps unknown failure strings to the workflow's stable terminal diagnostic code. */
function failureReasonCode(reason: string): FailureReasonCode {
  const parsed = failureReasonCodeSchema.safeParse(reason);
  return parsed.success ? parsed.data : 'workflow_failed';
}
