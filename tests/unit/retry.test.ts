import { describe, expect, it } from 'vitest';
import { BoundedRetryController, ModelGatewayTransportError, RetryLimitExceededError, RunBudgetLedger } from '@slacato/core';

describe('BoundedRetryController', () => {
  it('counts every provider call across transport and repair retries', () => {
    const controller = new BoundedRetryController({
      maxCalls: 2,
      maxSchemaRepairs: 1,
      maxTransportRetries: 1,
      deadlineMs: 1_000
    });

    controller.beginCall(1, 10);
    controller.recordTransportRetry(new ModelGatewayTransportError({ category: 'transient_transport', diagnosticCode: 'ETIMEDOUT' }));
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
      deadlineMs: 1_000
    });

    expect(controller.canRetryTransport(Object.assign(new Error('denied'), { code, retryable: true }))).toBe(false);
  });

  it('does not retry non-retryable client status codes even when marked retryable', () => {
    const controller = new BoundedRetryController({ maxCalls: 3, maxSchemaRepairs: 1, maxTransportRetries: 2, deadlineMs: 1_000 });
    expect(controller.canRetryTransport(Object.assign(new Error('denied'), { statusCode: 422, retryable: true }))).toBe(false);
  });

  it.each([401, 422])('lets authoritative non-retryable HTTP status %i defeat a forged transient category', (statusCode) => {
    const controller = new BoundedRetryController({ maxCalls: 3, maxSchemaRepairs: 1, maxTransportRetries: 2, deadlineMs: 1_000 });
    expect(controller.canRetryTransport({ statusCode, category: 'transient_transport', retryable: true })).toBe(false);
  });

  it.each([
    ['policy code variation', { category: 'policy', code: 'POLICY_VIOLATION' }],
    ['unknown retryable error', { retryable: true }]
  ])('does not retry %s without an explicit transient category', (_name, detail) => {
    const controller = new BoundedRetryController({ maxCalls: 3, maxSchemaRepairs: 1, maxTransportRetries: 2, deadlineMs: 1_000 });
    expect(controller.canRetryTransport(detail)).toBe(false);
  });

  it('retries an explicitly normalized transient transport error', () => {
    const controller = new BoundedRetryController({ maxCalls: 3, maxSchemaRepairs: 1, maxTransportRetries: 2, deadlineMs: 1_000 });
    expect(controller.canRetryTransport(new ModelGatewayTransportError({ category: 'transient_transport', diagnosticCode: 'ETIMEDOUT' }))).toBe(true);
  });

  it('finalizes local and shared reservations while retaining observed provider output usage', () => {
    const shared = new RunBudgetLedger({ scope: 'settled-attempt', maxCalls: 2, deadlineMs: 1_000 });
    const controller = new BoundedRetryController({ maxCalls: 2, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000 }, shared);
    const reservation = controller.beginCall(1, 10);

    controller.settleAttempt(reservation, 11);

    expect(controller.snapshot()).toMatchObject({ calls: 1, inputTokens: 1, outputTokens: 11, reservedOutputTokens: 0 });
    expect(() => controller.releaseAttempt(reservation)).toThrow('Unknown or settled');
    expect(() => shared.releaseAttempt(reservation.shared!)).toThrow('Unknown or settled');
    const secondReservation = shared.reserveAttempt(1, 1);
    expect(secondReservation.grantedOutputTokens).toBe(1);
    expect(() => shared.reserveAttempt(1, 1)).toThrow('call limit');
    shared.releaseAttempt(secondReservation);
  });
});
