import { Writable } from 'node:stream';
import { createSafeLogger, redactLogPayload } from '@slacato/infrastructure';
import { describe, expect, it } from 'vitest';

const REDACTED = '[REDACTED]';

describe('safe structured logging', () => {
  it('recursively redacts sensitive key variants while preserving useful fields', () => {
    const payload = {
      event: 'provider_attempt_completed',
      correlationId: 'correlation_1',
      runId: 'run_1',
      attemptId: 'attempt_1',
      status: 'completed',
      provider: 'mock',
      model: 'mock-brief',
      durationMs: 14,
      retryCount: 1,
      inputTokens: 42,
      outputTokens: 17,
      authorization: 'Bearer AUTHORIZATION_SENTINEL',
      headers: { Cookie: 'COOKIE_SENTINEL', 'x-api-key': 'API_KEY_SENTINEL' },
      msg: 'PINO_MSG_SENTINEL',
      auth: { bearer: 'AUTH_OBJECT_SENTINEL' },
      credentials: ['CREDENTIALS_SENTINEL'],
      requestAuth: 'REQUEST_AUTH_SENTINEL',
      providerCredentials: ['PROVIDER_CREDENTIALS_SENTINEL'],
      err: 'ERR_STRING_SENTINEL',
      error: 'ERROR_STRING_SENTINEL',
      request: {
        prompt_text: 'PROMPT_SENTINEL',
        messages: [{ role: 'user', content: 'MESSAGE_CONTENT_SENTINEL' }]
      },
      result: [{ completion: 'COMPLETION_SENTINEL' }],
      sourceBody: 'SOURCE_BODY_SENTINEL',
      sourceBodies: ['SOURCE_BODIES_SENTINEL'],
      sourceContents: ['SOURCE_CONTENTS_SENTINEL'],
      vendorEvidenceExcerpts: ['EVIDENCE_EXCERPTS_SENTINEL'],
      evidence_excerpt: 'EVIDENCE_EXCERPT_SENTINEL',
      secretKey: 'SECRET_KEY_SENTINEL',
      apiKeyValue: 'API_KEY_VALUE_SENTINEL',
      rawBody: 'RAW_BODY_SENTINEL',
      requestPayload: 'REQUEST_PAYLOAD_SENTINEL',
      neutralData: ['NEUTRAL_ARRAY_SENTINEL']
    };

    expect(redactLogPayload(payload)).toEqual({
      event: 'provider_attempt_completed',
      correlationId: 'correlation_1',
      runId: 'run_1',
      attemptId: 'attempt_1',
      status: 'completed',
      provider: 'mock',
      model: 'mock-brief',
      durationMs: 14,
      retryCount: 1,
      inputTokens: 42,
      outputTokens: 17
    });
  });

  it('preserves the diagnostic error class and workflow step for failed commands', () => {
    expect(
      redactLogPayload({
        event: 'workflow_command_failed',
        runId: 'run_diag',
        status: 'failed',
        step: 'synthesize',
        errorName: 'DomainConflictError',
        errorCode: 'WORKFLOW_COMMAND_FAILED'
      })
    ).toEqual({
      event: 'workflow_command_failed',
      runId: 'run_diag',
      status: 'failed',
      step: 'synthesize',
      errorName: 'DomainConflictError',
      errorCode: 'WORKFLOW_COMMAND_FAILED'
    });
  });

  it('still redacts an error message or stack smuggled through the diagnostic fields', () => {
    expect(
      redactLogPayload({
        event: 'workflow_command_failed',
        errorName: 'Error: leaked Northstar Foods account detail',
        step: 'Required retrieval checkpoint is missing'
      })
    ).toEqual({
      event: 'workflow_command_failed',
      errorName: REDACTED,
      step: REDACTED
    });
  });

  it('handles arrays, cycles, and Error objects without leaking messages, stacks, or causes', () => {
    const cause = new Error('CAUSE_SENTINEL');
    const error = Object.assign(new Error('ERROR_MESSAGE_SENTINEL', { cause }), { code: 'SAFE_PROVIDER_ERROR' });
    const cyclic: Record<string, unknown> = { runId: 'run_2', errors: [error] };
    cyclic.self = cyclic;

    expect(redactLogPayload(cyclic)).toEqual({ runId: 'run_2' });
  });

  it('redacts stack and cause fields on root and nested serialized errors', () => {
    const serialized = {
      name: 'ProviderError',
      message: 'SERIALIZED_MESSAGE_SENTINEL',
      stack: 'SERIALIZED_STACK_SENTINEL',
      cause: { message: 'SERIALIZED_CAUSE_SENTINEL' },
      code: 'SAFE_SERIALIZED_ERROR'
    };
    expect(redactLogPayload(serialized)).toEqual({});
    expect(redactLogPayload({ failure: serialized })).toEqual({});
  });

  it('redacts nested child bindings before they become persistent Pino context', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const log = createSafeLogger(destination).child({
      runId: 'run_child',
      context: { authorizationHeader: 'CHILD_AUTH_SENTINEL', prompt: 'CHILD_PROMPT_SENTINEL' }
    });

    log.info({ event: 'workflow_command_started', status: 'started' });
    log.flush();

    expect(output).not.toMatch(/CHILD_(?:AUTH|PROMPT)_SENTINEL/);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      runId: 'run_child',
      event: 'workflow_command_started',
      status: 'started'
    });
    expect(parsed).not.toHaveProperty('context');
  });

  it('never invokes accessors and fails closed on descriptor proxy traps', () => {
    let getterCalls = 0;
    const accessors = { event: 'provider_attempt_failed' } as Record<string, unknown>;
    Object.defineProperties(accessors, {
      requestPayload: {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 'UNKNOWN_ACCESSOR_SENTINEL';
        }
      },
      correlationId: {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error('KNOWN_ACCESSOR_SENTINEL');
        }
      }
    });
    const descriptorProxy = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error('DESCRIPTOR_TRAP_SENTINEL');
      }
    });

    expect(redactLogPayload(accessors)).toEqual({
      event: 'provider_attempt_failed',
      correlationId: REDACTED
    });
    expect(getterCalls).toBe(0);
    expect(redactLogPayload(descriptorProxy)).toBe(REDACTED);
  });

  it('drops unknown and reserved names with a fixed ordered output bound', () => {
    const payload: Record<string, unknown> = {
      outputTokens: 2,
      event: 'provider_attempt_completed',
      level: 'LEVEL_COLLISION_SENTINEL',
      time: 'TIME_COLLISION_SENTINEL',
      msg: 'MSG_COLLISION_SENTINEL',
      SECRET_IN_KEY_SENTINEL: true
    };
    for (let index = 0; index < 1_000; index += 1) {
      payload[`LONG_UNKNOWN_KEY_${index}_${'x'.repeat(1_000)}`] = 'UNKNOWN_VALUE_SENTINEL';
    }

    const projected = redactLogPayload(payload);
    expect(projected).toEqual({ event: 'provider_attempt_completed', outputTokens: 2 });
    expect(Object.keys(projected as object)).toEqual(['event', 'outputTokens']);
    expect(Object.keys(projected as object)).toHaveLength(2);
    expect(JSON.stringify(projected)).not.toMatch(/SECRET_IN_KEY|LONG_UNKNOWN_KEY|COLLISION_SENTINEL/);
  });

  it('enforces redaction before Pino serializes log payloads', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const log = createSafeLogger(destination);

    log.info({
      event: 'provider_attempt_failed',
      correlationId: 'correlation_3',
      runId: 'run_3',
      attemptId: 'attempt_3',
      status: 'failed',
      provider: 'ollama',
      model: 'model_3',
      durationMs: 23,
      retryCount: 2,
      inputTokens: 50,
      outputTokens: 0,
      errorCode: 'PROVIDER_UNAVAILABLE',
      apiKey: 'LOGGER_API_KEY_SENTINEL',
      prompt: 'LOGGER_PROMPT_SENTINEL',
      sourceContent: 'LOGGER_SOURCE_SENTINEL',
      evidenceExcerpt: 'LOGGER_EVIDENCE_SENTINEL',
      err: new Error('LOGGER_ERROR_SENTINEL'),
      secretKey: 'LOGGER_SECRET_KEY_SENTINEL',
      apiKeyValue: 'LOGGER_API_KEY_VALUE_SENTINEL',
      rawBody: 'LOGGER_RAW_BODY_SENTINEL',
      requestPayload: 'LOGGER_REQUEST_PAYLOAD_SENTINEL',
      neutralData: ['LOGGER_NEUTRAL_ARRAY_SENTINEL'],
      level: 'LOGGER_LEVEL_COLLISION_SENTINEL',
      time: 'LOGGER_TIME_COLLISION_SENTINEL',
      msg: 'LOGGER_MSG_COLLISION_SENTINEL',
      LOGGER_SECRET_IN_KEY_SENTINEL: true,
    });
    log.flush();

    expect(output).not.toMatch(/LOGGER_(?:API_KEY|PROMPT|SOURCE|EVIDENCE|ERROR|SECRET|RAW|REQUEST|NEUTRAL|LEVEL|TIME|MSG)_/);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event: 'provider_attempt_failed',
      correlationId: 'correlation_3',
      runId: 'run_3',
      attemptId: 'attempt_3',
      status: 'failed',
      provider: 'ollama',
      model: 'model_3',
      durationMs: 23,
      retryCount: 2,
      inputTokens: 50,
      outputTokens: 0,
      errorCode: 'PROVIDER_UNAVAILABLE'
    });
    expect(parsed.level).toBe(30);
    expect(parsed.time).toEqual(expect.any(String));
    expect(parsed).not.toHaveProperty('msg');
    expect(Object.keys(parsed)).toHaveLength(14);
  });
});
