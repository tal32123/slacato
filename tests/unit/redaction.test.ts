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
      evidence_excerpt: 'EVIDENCE_EXCERPT_SENTINEL'
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
      outputTokens: 17,
      authorization: REDACTED,
      headers: { Cookie: REDACTED, 'x-api-key': REDACTED },
      msg: REDACTED,
      auth: REDACTED,
      credentials: REDACTED,
      requestAuth: REDACTED,
      providerCredentials: REDACTED,
      err: REDACTED,
      error: REDACTED,
      request: { prompt_text: REDACTED, messages: REDACTED },
      result: [{ completion: REDACTED }],
      sourceBody: REDACTED,
      sourceBodies: REDACTED,
      sourceContents: REDACTED,
      vendorEvidenceExcerpts: REDACTED,
      evidence_excerpt: REDACTED
    });
  });

  it('handles arrays, cycles, and Error objects without leaking messages, stacks, or causes', () => {
    const cause = new Error('CAUSE_SENTINEL');
    const error = Object.assign(new Error('ERROR_MESSAGE_SENTINEL', { cause }), { code: 'SAFE_PROVIDER_ERROR' });
    const cyclic: Record<string, unknown> = { runId: 'run_2', errors: [error] };
    cyclic.self = cyclic;

    expect(redactLogPayload(cyclic)).toEqual({
      runId: 'run_2',
      errors: [{ name: 'Error', message: REDACTED, stack: REDACTED, cause: REDACTED, code: 'SAFE_PROVIDER_ERROR' }],
      self: '[Circular]'
    });
  });

  it('redacts stack and cause fields on root and nested serialized errors', () => {
    const serialized = {
      name: 'ProviderError',
      message: 'SERIALIZED_MESSAGE_SENTINEL',
      stack: 'SERIALIZED_STACK_SENTINEL',
      cause: { message: 'SERIALIZED_CAUSE_SENTINEL' },
      code: 'SAFE_SERIALIZED_ERROR'
    };
    const expected = {
      name: 'ProviderError',
      message: REDACTED,
      stack: REDACTED,
      cause: REDACTED,
      code: 'SAFE_SERIALIZED_ERROR'
    };

    expect(redactLogPayload(serialized)).toEqual(expected);
    expect(redactLogPayload({ failure: serialized })).toEqual({ failure: expected });
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
    expect(JSON.parse(output)).toMatchObject({
      runId: 'run_child',
      context: { authorizationHeader: REDACTED, prompt: REDACTED },
      event: 'workflow_command_started',
      status: 'started'
    });
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
      err: new Error('LOGGER_ERROR_SENTINEL')
    });
    log.flush();

    expect(output).not.toMatch(/LOGGER_(?:API_KEY|PROMPT|SOURCE|EVIDENCE|ERROR)_SENTINEL/);
    expect(JSON.parse(output)).toMatchObject({
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
      apiKey: REDACTED,
      prompt: REDACTED,
      sourceContent: REDACTED,
      evidenceExcerpt: REDACTED
    });
  });
});
