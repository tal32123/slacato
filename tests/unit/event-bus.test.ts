import { describe, expect, it } from 'vitest';
import {
  TraceCompletenessError,
  assertTraceComplete,
  createRunEventSubscription,
  type RunEventSubscriptionSource
} from '@slacato/core';
import {
  runEventEnvelopeSchema,
  runEventToPublishSchema,
  traceSpanSchema,
  type RunEventEnvelope,
  type TraceSpan
} from '@slacato/contracts';

const timestamp = '2026-08-29T12:00:00.000Z';

function event(id: string, streamId: string, sequence: number, type = 'progress'): RunEventEnvelope {
  return runEventEnvelopeSchema.parse({
    id,
    streamId,
    sequence,
    type,
    version: 1,
    timestamp,
    payload: { status: 'running' }
  });
}

async function collect<T>(iterable: AsyncIterable<T>, count: number): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
    if (values.length === count) break;
  }
  return values;
}

function span(
  runId: string,
  kind: TraceSpan['kind'],
  suffix: string,
  input: Readonly<{
    status: TraceSpan['status'];
    step?: string;
    attempt?: number;
    parentSpanId?: string;
    data: Readonly<Record<string, unknown>>;
  }>
): TraceSpan {
  return traceSpanSchema.parse({
    traceId: `trace_${runId}`,
    spanId: `span_${suffix}`,
    runId,
    kind,
    step: input.step ?? kind,
    attempt: input.attempt ?? 1,
    startedAt: timestamp,
    endedAt: timestamp,
    ...input
  });
}

function completedTrace(runId: string): TraceSpan[] {
  const auth = span(runId, 'authorization_lookup', 'auth', {
    status: 'completed',
    data: { decision: 'allowed', correlationHash: 'a'.repeat(64), readKinds: ['opportunity', 'account', 'requester', 'permissions'], readCount: 4 }
  });
  const retrieval = span(runId, 'evidence_retrieval', 'retrieval', {
    status: 'completed', parentSpanId: auth.spanId, data: { resultIds: ['ev-1'], scores: [0.9], evidenceCount: 1 }
  });
  const spans = [auth, retrieval];
  for (const specialist of ['conversation', 'stakeholder', 'commercial']) {
    const attempt = span(runId, 'specialist_attempt', specialist, {
      status: 'completed', step: specialist, parentSpanId: retrieval.spanId,
      data: { operation: specialist, logicalGenerationId: `generation-${specialist}` }
    });
    const model = span(runId, 'model_call', `${specialist}_model`, {
      status: 'completed', step: specialist, parentSpanId: attempt.spanId,
      data: {
        durableAttemptId: `attempt-${specialist}`, logicalGenerationId: `generation-${specialist}`, ordinal: 1,
        provider: 'mock', model: 'mock-brief', parametersHash: 'b'.repeat(64),
        outputMode: 'native_schema', possibleDuplicate: false
      }
    });
    spans.push(
      attempt,
      model,
      span(runId, 'validation', `${specialist}_validation`, {
        status: 'completed', step: specialist, parentSpanId: model.spanId, data: { decision: 'accepted', validationAttempts: 0 }
      }),
      span(runId, 'guardrail', `${specialist}_guardrail`, {
        status: 'completed', step: specialist, parentSpanId: model.spanId, data: { decision: 'passed' }
      }),
      span(runId, 'usage', `${specialist}_usage`, {
        status: 'completed', step: specialist, parentSpanId: model.spanId, data: { inputTokens: 10, outputTokens: 4 }
      })
    );
  }
  const strategy = span(runId, 'strategy_attempt', 'strategy', {
    status: 'completed', step: 'strategy', parentSpanId: retrieval.spanId,
    data: { operation: 'strategy', logicalGenerationId: 'generation-strategy' }
  });
  const strategyModel = span(runId, 'model_call', 'strategy_model', {
    status: 'completed', step: 'strategy', parentSpanId: strategy.spanId,
    data: {
      durableAttemptId: 'attempt-strategy', logicalGenerationId: 'generation-strategy', ordinal: 1,
      provider: 'mock', model: 'mock-brief', parametersHash: 'c'.repeat(64),
      outputMode: 'native_schema', possibleDuplicate: false
    }
  });
  spans.push(
    strategy,
    strategyModel,
    span(runId, 'validation', 'strategy_validation', {
      status: 'completed', step: 'strategy', parentSpanId: strategyModel.spanId, data: { decision: 'accepted', validationAttempts: 0 }
    }),
    span(runId, 'guardrail', 'strategy_guardrail', {
      status: 'completed', step: 'strategy', parentSpanId: strategyModel.spanId, data: { decision: 'passed' }
    }),
    span(runId, 'usage', 'strategy_usage', {
      status: 'completed', step: 'strategy', parentSpanId: strategyModel.spanId, data: { inputTokens: 20, outputTokens: 8 }
    }),
    span(runId, 'policy_decision', 'policy', {
      status: 'completed', parentSpanId: strategy.spanId,
      data: { decision: 'no_approval_required', policyHash: 'd'.repeat(64), subjectHash: 'f'.repeat(64) }
    }),
    span(runId, 'recommendation', 'recommendation', {
      status: 'completed', parentSpanId: strategy.spanId, data: { recommendationIds: ['rec-1'] }
    }),
    span(runId, 'finalization', 'finalization', {
      status: 'completed', parentSpanId: strategy.spanId, data: { decision: 'completed', artifactHash: 'e'.repeat(64) }
    })
  );
  return spans;
}

describe('generic run event subscription', () => {
  it('replays strictly after the cursor, deduplicates wakeups, and isolates streams', async () => {
    const runId = 'run-a';
    const rows = [
      event('evt-1', runId, 1),
      event('evt-other', 'run-b', 2),
      event('evt-2', runId, 2),
      event('evt-2', runId, 2),
      event('evt-3', runId, 3),
      event('evt-4', runId, 4)
    ];
    const source: RunEventSubscriptionSource = {
      resolveCursor: async (_streamId, afterId) => afterId === 'evt-2' ? 2 : 0,
      readAfter: async () => rows,
      waitForWake: () => Promise.resolve()
    };

    const events = await collect(createRunEventSubscription(source, runId, 'evt-2'), 2);

    expect(events.map(({ id }) => id)).toEqual(['evt-3', 'evt-4']);
    expect(events.every(({ streamId }) => streamId === runId)).toBe(true);
  });

  it('registers its wakeup before reading so an event committed during the snapshot race is not lost', async () => {
    const rows: RunEventEnvelope[] = [];
    const registered = Promise.withResolvers<void>();
    let firstRead = true;
    const source: RunEventSubscriptionSource = {
      resolveCursor: async () => 0,
      waitForWake: () => registered.promise,
      readAfter: async () => {
        if (firstRead) {
          firstRead = false;
          rows.push(event('evt-race', 'run-race', 1));
          registered.resolve();
          return [];
        }
        return rows;
      }
    };

    await expect(collect(createRunEventSubscription(source, 'run-race'), 1)).resolves.toMatchObject([{ id: 'evt-race' }]);
  });

  it('stops an idle subscription when its caller aborts', async () => {
    const abort = new AbortController();
    const woken = Promise.withResolvers<void>();
    const source: RunEventSubscriptionSource = {
      resolveCursor: async () => 0,
      readAfter: async () => [],
      waitForWake: (_streamId, signal) => {
        signal.addEventListener('abort', () => woken.resolve(), { once: true });
        return woken.promise;
      }
    };
    const iterator = createRunEventSubscription(source, 'run-abort', undefined, abort.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();

    abort.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });
});

describe('safe event contract', () => {
  it('rejects prompt, credential, locator, and oversized payload fields before persistence', () => {
    const base = { id: 'evt-safe', streamId: 'run-safe', type: 'progress', version: 1, timestamp };
    for (const payload of [
      { prompt: 'do not persist me' },
      { credential: 'secret' },
      { source_locator: 'restricted/path' },
      { status: 'x'.repeat(2_049) }
    ]) {
      expect(runEventToPublishSchema.safeParse({ ...base, payload }).success).toBe(false);
    }
    expect(runEventToPublishSchema.safeParse({ ...base, payload: { status: 'running' } }).success).toBe(true);
    expect(runEventToPublishSchema.safeParse({ ...base, id: 'evt-safe\nevent: complete', payload: { status: 'running' } }).success).toBe(false);
    for (const payload of [
      { status: 'running', sourceBody: 'restricted' },
      { status: 'running', sourceLocator: 'restricted/path' },
      { status: 'running', chainOfThought: 'private reasoning' },
      { status: 'running', rawPrompt: 'private prompt' },
      { status: 'running', reasoning: 'private reasoning' }
    ]) {
      expect(runEventToPublishSchema.safeParse({ ...base, payload }).success).toBe(false);
    }
  });
});

describe('trace completeness', () => {
  it('accepts a linked completed trace and rejects a missing specialist model call', () => {
    const runId = 'run-completed';
    const spans = completedTrace(runId);
    expect(() => assertTraceComplete(runId, spans)).not.toThrow();

    const incomplete = spans.filter((candidate) => !(candidate.kind === 'model_call' && candidate.step === 'commercial'));
    expect(() => assertTraceComplete(runId, incomplete)).toThrowError(TraceCompletenessError);
  });

  it('accepts awaiting approval only with requirements and validates every approval decision before finalization', () => {
    const runId = 'run-approval';
    const base = completedTrace(runId).filter(({ kind }) => kind !== 'finalization');
    const policy = base.find(({ kind }) => kind === 'policy_decision')!;
    const requirement = span(runId, 'approval_requirement', 'requirement', {
      status: 'completed',
      parentSpanId: policy.spanId,
      data: { subjectHash: 'f'.repeat(64), entryId: 'entry-1', category: 'commercial_discount', authorities: ['deal_desk'], policyHash: 'e'.repeat(64) }
    });
    expect(() => assertTraceComplete(runId, [...base, requirement])).not.toThrow();

    const finalized = [
      ...base,
      requirement,
      span(runId, 'finalization', 'approved_finalization', { status: 'completed', parentSpanId: requirement.spanId, data: { decision: 'completed', artifactHash: '1'.repeat(64) } })
    ];
    expect(() => assertTraceComplete(runId, finalized)).toThrowError(/approval decision/i);

    const decision = span(runId, 'approval_decision', 'decision', {
      status: 'completed', parentSpanId: requirement.spanId,
      data: { subjectHash: 'f'.repeat(64), entryId: 'entry-1', category: 'commercial_discount', authority: 'deal_desk', decision: 'approved' }
    });
    expect(() => assertTraceComplete(runId, [...finalized, decision])).not.toThrow();
  });

  it('requires degraded and failed outcomes to link the typed decision to its triggering attempt', () => {
    const runId = 'run-degraded';
    const spans = completedTrace(runId).map((candidate) => candidate.kind === 'specialist_attempt' && candidate.step === 'conversation'
      ? { ...candidate, status: 'degraded' as const } : candidate);
    const attempt = spans.find(({ kind, step }) => kind === 'specialist_attempt' && step === 'conversation')!;
    const partial = span(runId, 'partial_failure', 'partial', { status: 'degraded', step: 'conversation', parentSpanId: attempt.spanId, data: { decision: 'partial', reasonCode: 'conversation_unavailable' } });
    expect(() => assertTraceComplete(runId, [...spans, partial])).not.toThrow();
    expect(() => assertTraceComplete(runId, [...spans, { ...partial, parentSpanId: 'span-missing' }])).toThrowError(/triggering attempt/i);

    const failedRunId = 'run-failed';
    const auth = span(failedRunId, 'authorization_lookup', 'failed_auth', { status: 'completed', data: { decision: 'allowed', correlationHash: '2'.repeat(64), readKinds: ['opportunity'], readCount: 1 } });
    const retrieval = span(failedRunId, 'evidence_retrieval', 'failed_retrieval', { status: 'completed', parentSpanId: auth.spanId, data: { resultIds: [], scores: [], evidenceCount: 0 } });
    const completedAttempt = span(failedRunId, 'strategy_attempt', 'completed_strategy', { status: 'completed', step: 'strategy', parentSpanId: retrieval.spanId, data: { operation: 'strategy', logicalGenerationId: 'generation-completed' } });
    const failedAttempt = span(failedRunId, 'strategy_attempt', 'failed_strategy', { status: 'failed', step: 'strategy', parentSpanId: completedAttempt.spanId, data: { operation: 'strategy', logicalGenerationId: 'generation-failed' } });
    const fatal = span(failedRunId, 'fatal_failure', 'fatal', { status: 'failed', step: 'strategy', parentSpanId: failedAttempt.spanId, data: { decision: 'fatal', reasonCode: 'draft_validation_failed' } });
    expect(() => assertTraceComplete(failedRunId, [auth, retrieval, completedAttempt, failedAttempt, fatal])).not.toThrow();
    const unaccountedDegradedAttempt = span(failedRunId, 'specialist_attempt', 'degraded_conversation', { status: 'degraded', step: 'conversation', parentSpanId: retrieval.spanId, data: { operation: 'conversation', logicalGenerationId: 'generation-degraded' } });
    expect(() => assertTraceComplete(failedRunId, [auth, retrieval, unaccountedDegradedAttempt, completedAttempt, failedAttempt, fatal])).toThrowError(/partial/i);
    const mistypedFatal = span(failedRunId, 'fatal_failure', 'mistyped_fatal', { status: 'completed', step: 'strategy', parentSpanId: failedAttempt.spanId, data: { decision: 'fatal', reasonCode: 'draft_validation_failed' } });
    expect(() => assertTraceComplete(failedRunId, [auth, retrieval, completedAttempt, failedAttempt, mistypedFatal])).toThrow('Fatal decision is not typed as failed');
    const completedParentFatal = span(failedRunId, 'fatal_failure', 'completed_parent_fatal', { status: 'failed', step: 'strategy', parentSpanId: completedAttempt.spanId, data: { decision: 'fatal', reasonCode: 'draft_validation_failed' } });
    expect(() => assertTraceComplete(failedRunId, [auth, retrieval, completedAttempt, completedParentFatal])).toThrow('Fatal decision is not linked to a failed triggering attempt');
  });

  it('requires kind-specific trace facts and a typed decision for every degraded attempt', () => {
    const runId = 'run-strict-trace';
    const spans = completedTrace(runId);
    const model = spans.find(({ kind }) => kind === 'model_call')!;
    expect(() => traceSpanSchema.parse({ ...model, data: {} })).toThrowError();
    const retrieval = spans.find(({ kind }) => kind === 'evidence_retrieval')!;
    expect(() => traceSpanSchema.parse({ ...retrieval, data: { resultIds: [], scores: [] } })).toThrowError();

    const degraded = spans.map((candidate) => candidate.kind === 'specialist_attempt' && candidate.step === 'conversation'
      ? { ...candidate, status: 'degraded' as const }
      : candidate);
    expect(() => assertTraceComplete(runId, degraded)).toThrowError(/partial/i);
  });

  it('allows a denied trace to contain only safe authorization correlation data', () => {
    const runId = 'run-denied';
    const denied = span(runId, 'authorization_lookup', 'denied', {
      status: 'denied',
      data: {
        decision: 'denied', correlationHash: '3'.repeat(64), reasonCode: 'forbidden',
        readKinds: ['opportunity', 'account', 'requester', 'permissions'], readCount: 4
      }
    });
    expect(() => assertTraceComplete(runId, [denied])).not.toThrow();

    const leaked = span(runId, 'evidence_retrieval', 'leaked', { status: 'completed', parentSpanId: denied.spanId, data: { resultIds: ['restricted-id'], scores: [1], evidenceCount: 1 } });
    expect(() => assertTraceComplete(runId, [denied, leaked])).toThrowError(/denied trace/i);
    expect(() => traceSpanSchema.parse({ ...denied, data: { decision: 'denied', resultIds: ['restricted-id'] } })).toThrowError();
    expect(() => traceSpanSchema.parse({
      ...denied,
      data: { decision: 'denied', correlationHash: 'private prompt text', reasonCode: 'forbidden', readKinds: ['opportunity'], readCount: 1 }
    })).toThrowError();
  });
});
