import {
  runEventEnvelopeSchema,
  traceSpanSchema,
  type RunEventEnvelope,
  type RunEventToPublish,
  type RunSnapshot,
  type TraceSpan
} from '@slacato/contracts';

export interface RunEventBus {
  publish(envelope: RunEventToPublish): Promise<void>;
  subscribe(streamId: string, afterId?: string, signal?: AbortSignal): AsyncIterable<RunEventEnvelope>;
}

export interface RunEventSubscriptionSource {
  resolveCursor(streamId: string, afterId: string | undefined): Promise<number>;
  readAfter(streamId: string, afterSequence: number): Promise<readonly RunEventEnvelope[]>;
  /** Registration must happen synchronously when called; callers invoke this before reading. */
  waitForWake(streamId: string, signal: AbortSignal): Promise<void>;
}

export interface RunEventQuery {
  authorizeAndSnapshot(streamId: string, actorId: string): Promise<RunSnapshot | undefined>;
}

export interface TraceStore {
  appendTrace(span: TraceSpan): Promise<void>;
  tracesForRun(runId: string): Promise<readonly TraceSpan[]>;
  assertTraceComplete(runId: string): Promise<void>;
}

export class CursorExpiredError extends Error {
  public constructor() {
    super('Run event cursor is no longer retained');
    this.name = 'CursorExpiredError';
  }
}

export class TraceCompletenessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TraceCompletenessError';
  }
}

/**
 * Race-free replay loop shared by PostgreSQL and deterministic tests. A wakeup
 * is armed before every read; database rows, never notifications, remain the authority.
 */
export async function* createRunEventSubscription(
  source: RunEventSubscriptionSource,
  streamId: string,
  afterId?: string,
  signal: AbortSignal = new AbortController().signal
): AsyncIterable<RunEventEnvelope> {
  let sequence = await source.resolveCursor(streamId, afterId);
  while (!signal.aborted) {
    const cycle = new AbortController();
    const abortCycle = (): void => cycle.abort();
    signal.addEventListener('abort', abortCycle, { once: true });
    const wake = source.waitForWake(streamId, cycle.signal);
    let rows: readonly RunEventEnvelope[];
    try {
      rows = await source.readAfter(streamId, sequence);
    } catch (error) {
      cycle.abort();
      signal.removeEventListener('abort', abortCycle);
      throw error;
    }
    const ordered = rows
      .map((row) => runEventEnvelopeSchema.parse(row) as RunEventEnvelope)
      .filter((row) => row.streamId === streamId && row.sequence > sequence)
      .sort((left, right) => left.sequence - right.sequence);
    if (ordered.length > 0) {
      cycle.abort();
      signal.removeEventListener('abort', abortCycle);
      for (const row of ordered) {
        if (signal.aborted) return;
        if (row.sequence <= sequence) continue;
        sequence = row.sequence;
        yield row;
      }
      continue;
    }
    try {
      await wake;
    } finally {
      cycle.abort();
      signal.removeEventListener('abort', abortCycle);
    }
  }
}

function requireSpan(spans: readonly TraceSpan[], kind: TraceSpan['kind'], description: string): TraceSpan {
  const found = spans.find((span) => span.kind === kind);
  if (found === undefined) throw new TraceCompletenessError(`Trace is missing ${description}`);
  return found;
}

function parentOf(span: TraceSpan, byId: ReadonlyMap<string, TraceSpan>): TraceSpan | undefined {
  return span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
}
type TraceFor<K extends TraceSpan['kind']> = Extract<TraceSpan, { kind: K }>;

function spansOfKind<K extends TraceSpan['kind']>(spans: readonly TraceSpan[], kind: K): TraceFor<K>[] {
  return spans.filter((span) => span.kind === kind) as TraceFor<K>[];
}

function assertAttemptEvidence(spans: readonly TraceSpan[], attempt: TraceSpan): void {
  const models = spansOfKind(spans, 'model_call').filter((span) => span.step === attempt.step && span.parentSpanId === attempt.spanId);
  if (models.length === 0) throw new TraceCompletenessError(`Trace is missing model call for ${attempt.step}`);
  const ordinals = new Set<number>();
  for (const model of models) {
    if (ordinals.has(model.data.ordinal)) throw new TraceCompletenessError(`Trace has duplicate model ordinal for ${attempt.step}`);
    ordinals.add(model.data.ordinal);
    const validation = spansOfKind(spans, 'validation').find((span) => span.step === attempt.step && span.parentSpanId === model.spanId);
    if (validation === undefined) throw new TraceCompletenessError(`Trace is missing validation for ${attempt.step} attempt ${model.data.ordinal}`);
    if (!spansOfKind(spans, 'guardrail').some((span) => span.step === attempt.step && span.parentSpanId === model.spanId)) {
      throw new TraceCompletenessError(`Trace is missing guardrail for ${attempt.step} attempt ${model.data.ordinal}`);
    }
    if (!spansOfKind(spans, 'usage').some((span) => span.step === attempt.step && span.parentSpanId === model.spanId)) {
      throw new TraceCompletenessError(`Trace is missing usage for ${attempt.step} attempt ${model.data.ordinal}`);
    }
    if (validation.data.validationAttempts > 0
      && !spansOfKind(spans, 'repair').some((span) => span.step === attempt.step && span.parentSpanId === model.spanId)) {
      throw new TraceCompletenessError(`Trace is missing repair for ${attempt.step} attempt ${model.data.ordinal}`);
    }
  }
}

/** Deterministically verifies linkage and state-specific evidence without treating authorization reads as evidence. */
export function assertTraceComplete(runId: string, input: readonly TraceSpan[]): void {
  const spans = input.map((span) => traceSpanSchema.parse(span));
  if (spans.length === 0) throw new TraceCompletenessError('Trace has no spans');
  if (spans.some((span) => span.runId !== runId)) throw new TraceCompletenessError('Trace contains cross-run spans');
  const byId = new Map<string, TraceSpan>();
  for (const span of spans) {
    if (byId.has(span.spanId)) throw new TraceCompletenessError(`Trace has duplicate span ${span.spanId}`);
    byId.set(span.spanId, span);
  }
  const traceIds = new Set(spans.map(({ traceId }) => traceId));
  if (traceIds.size !== 1) throw new TraceCompletenessError('Trace contains multiple trace IDs');
  for (const span of spans) {
    if (span.parentSpanId !== undefined && !byId.has(span.parentSpanId)) {
      if (span.kind === 'partial_failure' || span.kind === 'fatal_failure') {
        throw new TraceCompletenessError(`${span.kind === 'partial_failure' ? 'Partial' : 'Fatal'} decision is not linked to its triggering attempt`);
      }
      throw new TraceCompletenessError(`Trace span ${span.spanId} has a missing parent`);
    }
  }

  const authorizations = spansOfKind(spans, 'authorization_lookup');
  if (authorizations.length === 0) throw new TraceCompletenessError('Trace is missing authorization lookup');
  const denied = authorizations.some((span) => span.status === 'denied' || span.data.decision === 'denied');
  if (denied) {
    if (spans.some(({ kind }) => kind !== 'authorization_lookup')) {
      throw new TraceCompletenessError('Denied trace contains evidence, agent, citation, recommendation, or locator facts');
    }
    if (authorizations.some((span) => span.status !== 'denied' || span.data.decision !== 'denied')) {
      throw new TraceCompletenessError('Denied trace contains a non-denial authorization result');
    }
    return;
  }
  if (!authorizations.some((span) => span.status === 'completed' && span.data.decision === 'allowed')) {
    throw new TraceCompletenessError('Trace has no permitted authorization decision');
  }

  const attempts = [
    ...spansOfKind(spans, 'specialist_attempt'),
    ...spansOfKind(spans, 'strategy_attempt')
  ];
  const fatalFailures = spansOfKind(spans, 'fatal_failure');
  for (const fatal of fatalFailures) {
    const triggering = parentOf(fatal, byId);
    if (triggering === undefined || triggering.status !== 'failed' || !['specialist_attempt', 'strategy_attempt'].includes(triggering.kind)) {
      throw new TraceCompletenessError('Fatal decision is not linked to a failed triggering attempt');
    }
    if (fatal.status !== 'failed' || fatal.data.decision !== 'fatal') {
      throw new TraceCompletenessError('Fatal decision is not typed as failed');
    }
  }
  const failedAttempts = attempts.filter((span) => span.status === 'failed');
  for (const attempt of failedAttempts) {
    if (!fatalFailures.some((span) => span.parentSpanId === attempt.spanId)) {
      throw new TraceCompletenessError('Failed attempt is missing its linked fatal decision');
    }
  }
  if (fatalFailures.length > 0) return;

  requireSpan(spans, 'evidence_retrieval', 'authorized evidence retrieval');
  for (const specialist of ['conversation', 'stakeholder', 'commercial']) {
    const attempt = spans.find((span) => span.kind === 'specialist_attempt' && span.step === specialist);
    if (attempt === undefined) throw new TraceCompletenessError(`Trace is missing ${specialist} specialist attempt`);
    assertAttemptEvidence(spans, attempt);
  }
  const strategy = spans.find((span) => span.kind === 'strategy_attempt');
  if (strategy === undefined) throw new TraceCompletenessError('Trace is missing strategy attempt');
  assertAttemptEvidence(spans, strategy);
  requireSpan(spans, 'policy_decision', 'policy decision');
  requireSpan(spans, 'recommendation', 'recommendation IDs');

  for (const partial of spansOfKind(spans, 'partial_failure')) {
    const triggering = parentOf(partial, byId);
    if (triggering === undefined || !['specialist_attempt', 'strategy_attempt'].includes(triggering.kind)) {
      throw new TraceCompletenessError('Partial decision is not linked to its triggering attempt');
    }
    if (partial.status !== 'degraded' || partial.data.decision !== 'partial') {
      throw new TraceCompletenessError('Partial decision is not typed as degraded');
    }
  }
  for (const attempt of [
    ...spansOfKind(spans, 'specialist_attempt'),
    ...spansOfKind(spans, 'strategy_attempt')
  ].filter((span) => span.status === 'degraded')) {
    const partial = spansOfKind(spans, 'partial_failure').find((span) => span.parentSpanId === attempt.spanId);
    if (partial === undefined || partial.status !== 'degraded' || partial.data.decision !== 'partial') {
      throw new TraceCompletenessError(`Degraded attempt ${attempt.step} is missing its linked partial decision`);
    }
  }

  const requirements = spansOfKind(spans, 'approval_requirement');
  for (const requirement of requirements) {
    if (typeof requirement.data.entryId !== 'string'
      || typeof requirement.data.subjectHash !== 'string'
      || typeof requirement.data.category !== 'string'
      || !Array.isArray(requirement.data.authorities)
      || requirement.data.authorities.length === 0
      || requirement.data.authorities.some((authority) => typeof authority !== 'string')) {
      throw new TraceCompletenessError('Approval requirement is missing subject, entry, category, or eligible authorities');
    }
  }
  const finalization = spans.find(({ kind }) => kind === 'finalization');
  if (finalization === undefined) {
    if (requirements.length === 0) throw new TraceCompletenessError('Non-terminal trace has no approval requirement');
    return;
  }
  const decisions = spansOfKind(spans, 'approval_decision');
  if (requirements.length > 0 && decisions.length === 0) throw new TraceCompletenessError('Trace is missing approval decision');
  for (const decision of decisions) {
    const requirement = parentOf(decision, byId);
    if (requirement?.kind !== 'approval_requirement') {
      throw new TraceCompletenessError('Approval decision is not linked to its requirement');
    }
    if (typeof decision.data.entryId !== 'string' || typeof decision.data.subjectHash !== 'string'
      || typeof decision.data.category !== 'string' || typeof decision.data.authority !== 'string'
      || typeof decision.data.decision !== 'string') {
      throw new TraceCompletenessError('Approval decision is missing subject, entry, category, authority, or decision');
    }
  }
}
