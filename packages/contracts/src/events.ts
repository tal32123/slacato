import { z } from 'zod';
import { runStatusSchema as canonicalRunStatusSchema, runFailureReasonSchema } from './runs.js';

export const opaqueIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const safeTokenSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime();
/**
 * Event payloads historically accept one extra value, 'running', beyond the
 * canonical run-status set exported from ./runs.js. Preserved verbatim here
 * (not merged into the canonical enum) because narrowing it would be a
 * behavior change, not a dedup — see run-status-parity.test.ts, which flags
 * this as a drift to resolve deliberately rather than silently.
 */
const runStatusSchema = z.enum([...canonicalRunStatusSchema.options, 'running']);
/** The run-failure codes live with the run contracts, because the run detail projects them too. */
const failureReasonSchema = runFailureReasonSchema;
const approvalCategorySchema = z.enum([
  'commercial_discount',
  'legal_terms',
  'evidence_review',
  'customer_communication',
  'customer_concession'
]);
const approvalAuthoritySchema = z.enum([
  'deal_desk',
  'sales_leader',
  'legal_reviewer',
  'account_owner'
]);

export const runEventCursorSchema = opaqueIdSchema;

const progressPayloadSchema = z.object({ status: runStatusSchema }).strict();
const runCreatedPayloadSchema = z
  .object({ status: z.literal('created'), deadlineMs: z.number().int().positive() })
  .strict();
const checkpointPayloadSchema = z
  .object({ step: safeTokenSchema, logicalGenerationId: opaqueIdSchema.optional() })
  .strict();
const transitionPayloadSchema = z
  .object({ version: z.number().int().nonnegative(), status: runStatusSchema })
  .strict();
const awaitingApprovalPayloadSchema = z
  .object({
    version: z.number().int().nonnegative(),
    subjectHash: hashSchema,
    quorumVersion: safeTokenSchema
  })
  .strict();
const approvalPayloadSchema = z
  .object({
    version: z.number().int().nonnegative(),
    approvalSubjectId: opaqueIdSchema,
    entryId: opaqueIdSchema,
    category: approvalCategorySchema,
    authority: approvalAuthoritySchema,
    action: z.enum(['approve_unchanged', 'edit_and_approve', 'reject']),
    approvedSubjectHash: hashSchema
  })
  .strict();
const rejectedApprovalPayloadSchema = approvalPayloadSchema
  .extend({ terminal: z.literal(true) })
  .strict();
const replacedPayloadSchema = z
  .object({
    priorSubjectId: opaqueIdSchema,
    approvalSubjectId: opaqueIdSchema,
    subjectHash: hashSchema
  })
  .strict();
const regenerationPayloadSchema = z
  .object({
    idempotencyHash: hashSchema,
    requestHash: hashSchema,
    draftVersion: z.number().int().nonnegative()
  })
  .strict();
const completePayloadSchema = z
  .object({
    version: z.number().int().nonnegative(),
    subjectHash: hashSchema,
    deterministic: z.literal(true),
    terminal: z.literal(true)
  })
  .strict();
const failPayloadSchema = z
  .object({
    version: z.number().int().nonnegative(),
    reasonCode: failureReasonSchema,
    terminal: z.literal(true)
  })
  .strict();
const cancelPayloadSchema = z
  .object({
    version: z.number().int().nonnegative(),
    cancelledBy: opaqueIdSchema,
    terminal: z.literal(true)
  })
  .strict();

export const safeEventPayloadSchema = z.union([
  progressPayloadSchema,
  runCreatedPayloadSchema,
  checkpointPayloadSchema,
  transitionPayloadSchema,
  awaitingApprovalPayloadSchema,
  rejectedApprovalPayloadSchema,
  approvalPayloadSchema,
  replacedPayloadSchema,
  regenerationPayloadSchema,
  completePayloadSchema,
  failPayloadSchema,
  cancelPayloadSchema
]);

const eventBase = {
  id: opaqueIdSchema,
  streamId: opaqueIdSchema,
  version: z.literal(1),
  timestamp: timestampSchema
};
/** Builds an unsequenced run-event contract with its type-specific payload. */
const eventVariant = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ ...eventBase, type: z.literal(type), payload }).strict();
/** Builds a persisted run-event contract with a positive stream sequence. */
const sequencedEventVariant = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z
    .object({ ...eventBase, sequence: z.number().int().positive(), type: z.literal(type), payload })
    .strict();

type RunEventStatus = z.infer<typeof runStatusSchema>;
type RunEventDefinition = readonly [
  type: string,
  payload: z.ZodType,
  metadata: Readonly<{ fallbackStatus?: RunEventStatus; terminal?: true }>
];

const eventDefinitions = [
  ['progress', progressPayloadSchema, {}],
  ['run_created', runCreatedPayloadSchema, { fallbackStatus: 'created' }],
  ['checkpoint_committed', checkpointPayloadSchema, {}],
  ['start', transitionPayloadSchema, { fallbackStatus: 'retrieving' }],
  ['retrieval_completed', transitionPayloadSchema, { fallbackStatus: 'specialists_running' }],
  ['specialists_completed', transitionPayloadSchema, { fallbackStatus: 'synthesizing' }],
  ['synthesis_completed', transitionPayloadSchema, { fallbackStatus: 'validating' }],
  ['validation_completed', transitionPayloadSchema, { fallbackStatus: 'finalizing' }],
  [
    'validation_requires_approval',
    transitionPayloadSchema,
    { fallbackStatus: 'awaiting_approval' }
  ],
  ['awaiting_approval', awaitingApprovalPayloadSchema, { fallbackStatus: 'awaiting_approval' }],
  ['approval_entry_recorded', approvalPayloadSchema, { fallbackStatus: 'awaiting_approval' }],
  ['approval_granted', approvalPayloadSchema, { fallbackStatus: 'finalizing' }],
  [
    'approval_rejected',
    rejectedApprovalPayloadSchema,
    { fallbackStatus: 'rejected', terminal: true }
  ],
  ['approval_subject_replaced', replacedPayloadSchema, { fallbackStatus: 'awaiting_approval' }],
  ['regeneration_requested', regenerationPayloadSchema, { fallbackStatus: 'synthesizing' }],
  ['complete', completePayloadSchema, { fallbackStatus: 'completed', terminal: true }],
  ['fail', failPayloadSchema, { fallbackStatus: 'failed', terminal: true }],
  ['cancel', cancelPayloadSchema, { terminal: true }]
] as const satisfies readonly RunEventDefinition[];

export type RunEventType = (typeof eventDefinitions)[number][0];

export const runEventTypes: readonly RunEventType[] = Object.freeze(
  eventDefinitions.map(([type]) => type)
);
export const terminalRunEventTypes: readonly RunEventType[] = Object.freeze(
  eventDefinitions.flatMap(([type, , metadata]) => ('terminal' in metadata ? [type] : []))
);
export const runEventFallbackStatuses: Readonly<Partial<Record<RunEventType, RunEventStatus>>> =
  Object.freeze(
    Object.fromEntries(
      eventDefinitions.flatMap(([type, , metadata]) =>
        'fallbackStatus' in metadata ? [[type, metadata.fallbackStatus] as const] : []
      )
    )
  );

export const runEventToPublishSchema = z.discriminatedUnion('type', [
  ...eventDefinitions.map(([type, payload]) => eventVariant(type, payload))
] as unknown as [
  ReturnType<typeof eventVariant>,
  ReturnType<typeof eventVariant>,
  ...ReturnType<typeof eventVariant>[]
]);

export const runEventEnvelopeSchema = z.discriminatedUnion('type', [
  ...eventDefinitions.map(([type, payload]) => sequencedEventVariant(type, payload))
] as unknown as [
  ReturnType<typeof sequencedEventVariant>,
  ReturnType<typeof sequencedEventVariant>,
  ...ReturnType<typeof sequencedEventVariant>[]
]);

export const sseEnvelopeSchema = runEventEnvelopeSchema;

export const runSnapshotSchema = z
  .object({
    streamId: opaqueIdSchema,
    status: runStatusSchema,
    version: z.number().int().nonnegative(),
    watermark: runEventCursorSchema.nullable(),
    terminal: z.boolean()
  })
  .strict();

export const runEventResyncInstructionSchema = z
  .object({
    type: z.literal('stream.resync_required'),
    version: z.literal(1),
    streamId: opaqueIdSchema,
    timestamp: timestampSchema,
    payload: z
      .object({
        reason: z.literal('cursor_expired'),
        snapshotPath: z.string().regex(/^\/api\/runs\/[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      })
      .strict()
  })
  .strict();

export const traceKindSchema = z.enum([
  'authorization_lookup',
  'evidence_retrieval',
  'specialist_attempt',
  'strategy_attempt',
  'model_call',
  'validation',
  'repair',
  'guardrail',
  'policy_decision',
  'approval_requirement',
  'approval_decision',
  'recommendation',
  'finalization',
  'usage',
  'partial_failure',
  'fatal_failure'
]);
export const traceStatusSchema = z.enum(['completed', 'degraded', 'failed', 'denied', 'skipped']);

const authorizationDataSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('allowed'),
      correlationHash: hashSchema,
      readKinds: z
        .array(z.enum(['opportunity', 'account', 'requester', 'permissions']))
        .min(1)
        .max(4),
      readCount: z.number().int().min(1).max(4)
    })
    .strict(),
  z
    .object({
      decision: z.literal('denied'),
      correlationHash: hashSchema,
      reasonCode: z.literal('forbidden'),
      readKinds: z
        .array(z.enum(['opportunity', 'account', 'requester', 'permissions']))
        .min(1)
        .max(4),
      readCount: z.number().int().min(1).max(4)
    })
    .strict()
]);
const retrievalDataSchema = z
  .object({
    resultIds: z.array(opaqueIdSchema).max(256),
    scores: z.array(z.number().finite()).max(256),
    evidenceCount: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((data, context) => {
    if (data.resultIds.length !== data.evidenceCount)
      context.addIssue({ code: 'custom', message: 'Evidence count must match result IDs' });
    if (data.scores.length > data.resultIds.length)
      context.addIssue({ code: 'custom', message: 'Scores cannot outnumber result IDs' });
  });
const attemptDataSchema = z
  .object({ operation: safeTokenSchema, logicalGenerationId: opaqueIdSchema })
  .strict();
const modelCallDataSchema = z
  .object({
    durableAttemptId: opaqueIdSchema,
    logicalGenerationId: opaqueIdSchema,
    ordinal: z.number().int().positive(),
    provider: safeTokenSchema,
    model: safeTokenSchema,
    parametersHash: hashSchema,
    outputMode: z.enum(['native_schema', 'prompted_json']).nullable(),
    possibleDuplicate: z.boolean()
  })
  .strict();
const validationDataSchema = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    validationAttempts: z.number().int().nonnegative()
  })
  .strict();
const repairDataSchema = z
  .object({ attempts: z.number().int().positive(), decision: z.literal('validated') })
  .strict();
const guardrailDataSchema = z.object({ decision: z.enum(['passed', 'blocked']) }).strict();
const policyDataSchema = z
  .object({
    decision: z.enum(['approval_required', 'no_approval_required']),
    policyHash: hashSchema,
    subjectHash: hashSchema
  })
  .strict();
const approvalRequirementDataSchema = z
  .object({
    subjectHash: hashSchema,
    entryId: opaqueIdSchema,
    category: approvalCategorySchema,
    authorities: z.array(approvalAuthoritySchema).min(1).max(4),
    policyHash: hashSchema
  })
  .strict();
const approvalDecisionDataSchema = z
  .object({
    subjectHash: hashSchema,
    entryId: opaqueIdSchema,
    category: approvalCategorySchema,
    authority: approvalAuthoritySchema,
    decision: z.enum(['approved', 'rejected', 'edited'])
  })
  .strict();
const recommendationDataSchema = z
  .object({ recommendationIds: z.array(opaqueIdSchema).max(256) })
  .strict();
const finalizationDataSchema = z
  .object({ decision: z.literal('completed'), artifactHash: hashSchema })
  .strict();
const usageDataSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative()
  })
  .strict();
const partialDataSchema = z
  .object({ decision: z.literal('partial'), reasonCode: failureReasonSchema })
  .strict();
const fatalDataSchema = z
  .object({ decision: z.literal('fatal'), reasonCode: failureReasonSchema })
  .strict();

export const safeTraceDataSchema = z.union([
  authorizationDataSchema,
  retrievalDataSchema,
  attemptDataSchema,
  modelCallDataSchema,
  validationDataSchema,
  repairDataSchema,
  guardrailDataSchema,
  policyDataSchema,
  approvalRequirementDataSchema,
  approvalDecisionDataSchema,
  recommendationDataSchema,
  finalizationDataSchema,
  usageDataSchema,
  partialDataSchema,
  fatalDataSchema
]);

const traceBase = {
  traceId: opaqueIdSchema,
  spanId: opaqueIdSchema,
  parentSpanId: opaqueIdSchema.optional(),
  runId: opaqueIdSchema,
  step: safeTokenSchema,
  attempt: z.number().int().positive(),
  status: traceStatusSchema,
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional()
};
/** Builds a trace-span contract with its kind-specific diagnostic data. */
const traceVariant = <T extends z.infer<typeof traceKindSchema>, P extends z.ZodType>(
  kind: T,
  data: P
) => z.object({ ...traceBase, kind: z.literal(kind), data }).strict();

export const traceSpanSchema = z
  .discriminatedUnion('kind', [
    traceVariant('authorization_lookup', authorizationDataSchema),
    traceVariant('evidence_retrieval', retrievalDataSchema),
    traceVariant('specialist_attempt', attemptDataSchema),
    traceVariant('strategy_attempt', attemptDataSchema),
    traceVariant('model_call', modelCallDataSchema),
    traceVariant('validation', validationDataSchema),
    traceVariant('repair', repairDataSchema),
    traceVariant('guardrail', guardrailDataSchema),
    traceVariant('policy_decision', policyDataSchema),
    traceVariant('approval_requirement', approvalRequirementDataSchema),
    traceVariant('approval_decision', approvalDecisionDataSchema),
    traceVariant('recommendation', recommendationDataSchema),
    traceVariant('finalization', finalizationDataSchema),
    traceVariant('usage', usageDataSchema),
    traceVariant('partial_failure', partialDataSchema),
    traceVariant('fatal_failure', fatalDataSchema)
  ])
  .superRefine((span, context) => {
    if (span.endedAt !== undefined && Date.parse(span.endedAt) < Date.parse(span.startedAt)) {
      context.addIssue({ code: 'custom', message: 'Trace span cannot end before it starts' });
    }
  });

export type SafeEventPayload = z.infer<typeof safeEventPayloadSchema>;
export type RunEventToPublish = Readonly<{
  id: string;
  streamId: string;
  type: RunEventType;
  version: 1;
  timestamp: string;
  payload: SafeEventPayload;
}>;
export type RunEventEnvelope = RunEventToPublish & Readonly<{ sequence: number }>;
export type SseEnvelope = RunEventEnvelope;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
export type RunEventResyncInstruction = z.infer<typeof runEventResyncInstructionSchema>;
export type TraceKind = z.infer<typeof traceKindSchema>;
export type TraceStatus = z.infer<typeof traceStatusSchema>;
export type TraceSpan = z.infer<typeof traceSpanSchema>;
