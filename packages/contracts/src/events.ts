import { z } from 'zod';

const MAX_SAFE_PAYLOAD_BYTES = 16_384;
const forbiddenSafeKey = /(?:^|_)(?:authorization|body|chain_of_thought|content|cookie|credential|evidence_text|locator|messages?|password|prompt|raw|secret|source_body|source_locator|token)(?:$|_)/i;

function validateSafeValue(value: unknown, context: z.core.$RefinementCtx<unknown>): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Safe payload must be JSON serializable' });
    return;
  }
  if (serialized.length > MAX_SAFE_PAYLOAD_BYTES) {
    context.addIssue({ code: 'custom', message: 'Safe payload exceeds the 16 KiB boundary' });
  }
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 8) {
      context.addIssue({ code: 'custom', message: 'Safe payload nesting is too deep' });
      return;
    }
    if (typeof candidate === 'string' && candidate.length > 2_048) {
      context.addIssue({ code: 'custom', message: 'Safe payload strings must be bounded' });
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 256) context.addIssue({ code: 'custom', message: 'Safe payload arrays must be bounded' });
      candidate.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (key.length > 80 || forbiddenSafeKey.test(key)) {
        context.addIssue({ code: 'custom', message: `Unsafe payload field: ${key}` });
      }
      visit(nested, depth + 1);
    }
  };
  visit(value, 0);
}

/** Bounded JSON facts safe to expose to an authorized progress consumer. */
export const safeEventPayloadSchema = z.record(z.string().min(1).max(80), z.json()).superRefine(validateSafeValue);

const envelopeBaseSchema = z.object({
  id: z.string().min(1).max(256),
  streamId: z.string().min(1).max(256),
  type: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
  version: z.number().int().positive(),
  timestamp: z.string().datetime(),
  payload: safeEventPayloadSchema
}).strict();

/** Input accepted by publishers; PostgreSQL allocates the authoritative sequence. */
export const runEventToPublishSchema = envelopeBaseSchema;

/** Generic, deal-rule-free run event returned by replay and live subscriptions. */
export const runEventEnvelopeSchema = envelopeBaseSchema.extend({
  sequence: z.number().int().positive()
}).strict();

/** Backwards-compatible name for the one transport event convention. */
export const sseEnvelopeSchema = runEventEnvelopeSchema;

export const runEventCursorSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const runSnapshotSchema = z.object({
  streamId: z.string().min(1).max(256),
  status: z.string().min(1).max(80),
  version: z.number().int().nonnegative(),
  watermark: runEventCursorSchema.nullable(),
  terminal: z.boolean()
}).strict();

/** Control instruction intentionally has no event ID, so it cannot advance a browser reconnect cursor. */
export const runEventResyncInstructionSchema = z.object({
  type: z.literal('stream.resync_required'),
  version: z.literal(1),
  streamId: z.string().min(1).max(256),
  timestamp: z.string().datetime(),
  payload: z.object({
    reason: z.literal('cursor_expired'),
    snapshotPath: z.string().regex(/^\/api\/runs\/[A-Za-z0-9._:-]+$/)
  }).strict()
}).strict();

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
export const safeTraceDataSchema = z.record(z.string().min(1).max(80), z.json()).superRefine(validateSafeValue);

/** Append-only safe trace fact. Prompts, source bodies, locators, and reasoning are structurally rejected. */
export const traceSpanSchema = z.object({
  traceId: z.string().min(1).max(256),
  spanId: z.string().min(1).max(256),
  parentSpanId: z.string().min(1).max(256).optional(),
  runId: z.string().min(1).max(256),
  step: z.string().min(1).max(128),
  attempt: z.number().int().positive(),
  kind: traceKindSchema,
  status: traceStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  data: safeTraceDataSchema
}).strict().superRefine((span, context) => {
  if (span.endedAt !== undefined && Date.parse(span.endedAt) < Date.parse(span.startedAt)) {
    context.addIssue({ code: 'custom', message: 'Trace span cannot end before it starts' });
  }
  if (span.kind !== 'authorization_lookup') return;
  const allowed: Readonly<Record<string, true>> = {
    decision: true,
    correlationHash: true,
    reasonCode: true,
    readKinds: true,
    readCount: true
  };
  for (const key of Object.keys(span.data)) {
    if (allowed[key] !== true) context.addIssue({ code: 'custom', message: 'Authorization lookup contains non-correlation data' });
  }
  if (!['allowed', 'denied'].includes(String(span.data.decision))) {
    context.addIssue({ code: 'custom', message: 'Authorization lookup requires an allowed or denied decision' });
  }
});

export type SafeEventPayload = z.infer<typeof safeEventPayloadSchema>;
export type RunEventToPublish = z.infer<typeof runEventToPublishSchema>;
export type RunEventEnvelope = z.infer<typeof runEventEnvelopeSchema>;
export type SseEnvelope = RunEventEnvelope;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
export type RunEventResyncInstruction = z.infer<typeof runEventResyncInstructionSchema>;
export type TraceKind = z.infer<typeof traceKindSchema>;
export type TraceStatus = z.infer<typeof traceStatusSchema>;
export type TraceSpan = z.infer<typeof traceSpanSchema>;
