import { describe, expect, it } from 'vitest';
import { BoundedRetryController, createBudgetedModelGateway, type ModelTransport, type ProviderAttemptLedger } from '@slacato/core';
import { normalizeOllamaTransportError } from '@slacato/infrastructure/model/ollama';
import { z } from 'zod';

const schema = z.object({ stakeholders: z.array(z.unknown()) }).strict();
const probeLedger: ProviderAttemptLedger = {
  async beginAttempt() { return { reservationId: 'probe-reservation', attemptId: 'probe-attempt', ordinal: 1, grantedOutputTokens: 20 }; },
  async settleAttempt() {}, async releaseAttempt() {}
};

function apiCallError(statusCode: number | undefined, isRetryable: boolean, extra: Record<PropertyKey, unknown> = {}): Error & Record<PropertyKey, unknown> {
  return Object.assign(new Error('provider request failed'), {
    [Symbol.for('vercel.ai.error.AI_APICallError')]: true,
    statusCode,
    isRetryable,
    ...extra
  });
}

describe('Ollama transport error boundary', () => {
  it('normalizes an AI SDK network APICallError to transient transport and retries it', async () => {
    let calls = 0;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() {
        calls += 1;
        if (calls === 1) throw normalizeOllamaTransportError(apiCallError(undefined, true));
        return { text: '{"stakeholders":[]}', usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };

    await expect(createBudgetedModelGateway(transport, undefined, probeLedger).generateObject({
      schema, messages: [{ role: 'user', content: 'Return JSON.' }], operation: 'retry-network',
      durableAttempt: { runScope: 'probe-run', provider: 'probe', model: 'probe-model' },
      limits: { maxCalls: 2, maxSchemaRepairs: 0, maxTransportRetries: 1, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 20 }
    })).resolves.toMatchObject({ value: { stakeholders: [] } });

    expect(calls).toBe(2);
  });

  it.each([
    ['authorization', apiCallError(401, false), 'authorization'],
    ['rate limit', apiCallError(429, true), 'rate_limited'],
    ['retryable server', apiCallError(503, true), 'server'],
    ['nonretryable client', apiCallError(422, false), 'nonretryable_client'],
    ['unknown', new Error('unclassified'), 'unknown']
  ])('normalizes %s SDK errors at the adapter boundary', (_name, error, category) => {
    const normalized = normalizeOllamaTransportError(error);
    expect(normalized).toMatchObject({
      name: 'ModelGatewayTransportError', category
    });
    expect(new BoundedRetryController({ maxCalls: 2, maxSchemaRepairs: 0, maxTransportRetries: 1, deadlineMs: 1_000, maxInputTokens: 100, maxOutputTokens: 20 })
      .canRetryTransport(normalized)).toBe(category === 'rate_limited' || category === 'server');
  });

  it('lets an authoritative authorization status defeat forged provider metadata', () => {
    const normalized = normalizeOllamaTransportError(apiCallError(401, true, {
      data: { category: 'transient_transport', code: 'NETWORK_RETRY' }
    }));

    expect(normalized.category).toBe('authorization');
    expect(new BoundedRetryController({ maxCalls: 2, maxSchemaRepairs: 0, maxTransportRetries: 1, deadlineMs: 1_000, maxInputTokens: 100, maxOutputTokens: 20 })
      .canRetryTransport(normalized)).toBe(false);
  });

  it('redacts provider secrets and request bodies from normalized transport errors', () => {
    const secret = 'Bearer super-secret-token';
    const evidence = 'private-customer-evidence';
    const raw = Object.assign(new Error(`${secret} ${evidence}`), {
      [Symbol.for('vercel.ai.error.AI_APICallError')]: true,
      statusCode: 422,
      isRetryable: false,
      requestBodyValues: { prompt: evidence },
      responseBody: evidence,
      responseHeaders: { authorization: secret },
      data: { category: 'transient_transport', code: 'NETWORK_RETRY', evidence }
    });

    const normalized = normalizeOllamaTransportError(raw);
    const exposed = `${JSON.stringify(normalized)} ${normalized.message} ${normalized.stack ?? ''} ${JSON.stringify(normalized.cause)}`;
    expect(normalized.category).toBe('nonretryable_client');
    expect(normalized.normalized.statusCode).toBe(422);
    expect(exposed).not.toContain(secret);
    expect(exposed).not.toContain(evidence);
    expect(normalized.cause).toBeUndefined();
  });
});
