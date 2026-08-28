import { describe, expect, it } from 'vitest';
import { BoundedRetryController, RetryLimitExceededError } from '@slacato/core';

describe('BoundedRetryController', () => {
  it('counts every provider call across transport and repair retries', () => {
    const controller = new BoundedRetryController({
      maxCalls: 2,
      maxSchemaRepairs: 1,
      maxTransportRetries: 1,
      deadlineMs: 1_000,
      maxInputTokens: 100,
      maxOutputTokens: 100
    });

    controller.beginCall(1, 10);
    controller.recordTransportRetry({ category: 'transient_transport', code: 'network_timeout' });
    controller.beginCall(1, 10);

    controller.recordSchemaRepair();

    expect(() => controller.beginCall(1, 10)).toThrow(RetryLimitExceededError);
    expect(controller.snapshot()).toMatchObject({ calls: 2, transportRetries: 1, schemaRepairs: 1 });
  });

  it.each([
    ['authorization', 'AUTHORIZATION_DENIED'],
    ['policy', 'POLICY_DENIED'],
    ['content filter', 'CONTENT_FILTERED'],
    ['citation', 'DETERMINISTIC_CITATION_FAILURE']
  ])('does not retry %s errors even when marked retryable', (_name, code) => {
    const controller = new BoundedRetryController({
      maxCalls: 3,
      maxSchemaRepairs: 1,
      maxTransportRetries: 2,
      deadlineMs: 1_000,
      maxInputTokens: 100,
      maxOutputTokens: 100
    });

    expect(controller.canRetryTransport(Object.assign(new Error('denied'), { code, retryable: true }))).toBe(false);
  });

  it('does not retry non-retryable client status codes even when marked retryable', () => {
    const controller = new BoundedRetryController({ maxCalls: 3, maxSchemaRepairs: 1, maxTransportRetries: 2, deadlineMs: 1_000, maxInputTokens: 100, maxOutputTokens: 100 });
    expect(controller.canRetryTransport(Object.assign(new Error('denied'), { statusCode: 422, retryable: true }))).toBe(false);
  });

  it.each([
    ['policy code variation', { category: 'policy', code: 'POLICY_VIOLATION' }],
    ['unknown retryable error', { retryable: true }]
  ])('does not retry %s without an explicit transient category', (_name, detail) => {
    const controller = new BoundedRetryController({ maxCalls: 3, maxSchemaRepairs: 1, maxTransportRetries: 2, deadlineMs: 1_000, maxInputTokens: 100, maxOutputTokens: 100 });
    expect(controller.canRetryTransport(detail)).toBe(false);
  });

  it('retries an explicitly normalized transient transport error', () => {
    const controller = new BoundedRetryController({ maxCalls: 3, maxSchemaRepairs: 1, maxTransportRetries: 2, deadlineMs: 1_000, maxInputTokens: 100, maxOutputTokens: 100 });
    expect(controller.canRetryTransport({ category: 'transient_transport', code: 'provider_diagnostic' })).toBe(true);
  });
});
