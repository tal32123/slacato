import { describe, expect, it } from 'vitest';
import { BoundedRetryController, RetryLimitExceededError } from '@slacato/core';

describe('BoundedRetryController', () => {
  it('counts every provider call across transport and repair retries', () => {
    const controller = new BoundedRetryController({
      maxCalls: 2,
      maxSchemaRepairs: 1,
      maxTransportRetries: 1,
      deadlineMs: 1_000,
      maxOutputTokens: 100
    });

    controller.beginCall();
    controller.recordTransportRetry(Object.assign(new Error('network timeout'), { retryable: true }));
    controller.beginCall();

    controller.recordSchemaRepair();

    expect(() => controller.beginCall()).toThrow(RetryLimitExceededError);
    expect(controller.snapshot()).toMatchObject({ calls: 2, transportRetries: 1, schemaRepairs: 1 });
  });

  it('does not retry authorization errors', () => {
    const controller = new BoundedRetryController({
      maxCalls: 3,
      maxSchemaRepairs: 1,
      maxTransportRetries: 2,
      deadlineMs: 1_000,
      maxOutputTokens: 100
    });

    expect(controller.canRetryTransport(Object.assign(new Error('denied'), { statusCode: 401 }))).toBe(false);
  });
});
