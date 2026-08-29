import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  createBudgetedModelGateway,
  ContextWindowPolicy,
  ModelGatewayTransportError,
  RunBudgetLedger,
  type GenerateObjectRequest,
  type ProviderAttemptLedger,
  type ModelTransport,
  type TransportGeneration
} from '@slacato/core';
import { vi } from 'vitest';

const schema = z.object({
  stakeholders: z.array(z.object({ role: z.enum(['champion', 'economic_buyer']) }))
}).strict();

function ephemeralLedger(): ProviderAttemptLedger {
  let ordinal = 0;
  return {
    async beginAttempt() { ordinal += 1; return { reservationId: `ephemeral-reservation-${ordinal}`, attemptId: `ephemeral-attempt-${ordinal}`, ordinal, grantedOutputTokens: 100 }; },
    async settleAttempt() {}, async releaseAttempt() {}
  };
}

/** Explicit test-only accounting; production composition supplies PostgreSQL. */
function createTestGateway(transport: ModelTransport, policy?: ConstructorParameters<typeof createBudgetedModelGateway>[1]) {
  const gateway = createBudgetedModelGateway(transport, policy, ephemeralLedger());
  return {
    generateObject<Value>(request: Omit<GenerateObjectRequest<Value>, 'durableAttempt'>) {
      return gateway.generateObject({ ...request, durableAttempt: { runScope: 'test-run', provider: 'test', model: 'test-model' } });
    }
  };
}

describe('BudgetedModelGateway', () => {
  it('rejects an unmetered request before its transport can run even when JavaScript bypasses the types', async () => {
    let calls = 0;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() { calls += 1; return { text: '{"stakeholders":[]}' }; }
    };
    const gateway = createBudgetedModelGateway(transport, undefined, ephemeralLedger());
    await expect(gateway.generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'unmetered',
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 100, maxOutputTokens: 100 }
    } as never)).rejects.toThrow('Durable attempt context');
    expect(calls).toBe(0);
  });

  it('rejects a gateway constructed without a ledger before its transport can run', async () => {
    let calls = 0;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() { calls += 1; return { text: '{"stakeholders":[]}' }; }
    };
    const gateway = createBudgetedModelGateway(transport, undefined, undefined as never);
    await expect(gateway.generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'missing-ledger',
      durableAttempt: { runScope: 'test-run', provider: 'test', model: 'test-model' },
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 100, maxOutputTokens: 100 }
    })).rejects.toThrow('Provider attempt ledger');
    expect(calls).toBe(0);
  });

  it('durably begins and settles every schema-repair transport attempt before calling the provider', async () => {
    const events: string[] = [];
    let ordinal = 0;
    const ledger: ProviderAttemptLedger = {
      async beginAttempt() {
        ordinal += 1;
        events.push(`begin:${ordinal}`);
        return { reservationId: `reservation-${ordinal}`, attemptId: `attempt-${ordinal}`, ordinal, grantedOutputTokens: 100 };
      },
      async settleAttempt(input) { events.push(`settle:${input.reservationId}`); },
      async releaseAttempt(input) { events.push(`release:${input.reservationId}`); }
    };
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate(request) {
        events.push(`transport:${request.maxOutputTokens}`);
        return events.filter((event) => event.startsWith('transport')).length === 1
          ? { text: '{"stakeholders":[{"role":"buyer"}]}' }
          : { text: '{"stakeholders":[]}' };
      }
    };

    const result = await createBudgetedModelGateway(transport, undefined, ledger).generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'durable-schema-repair',
      durableAttempt: { runScope: 'run-durable', invocationId: 'invocation-durable', provider: 'mock', model: 'mock-chat' },
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 200 }
    });

    expect(result.value).toEqual({ stakeholders: [] });
    expect(events).toEqual(['begin:1', 'transport:undefined', 'settle:reservation-1', 'begin:2', 'transport:undefined', 'settle:reservation-2']);
  });

  it('allows repair and re-repair independently for each structured-output request', async () => {
    const attemptsByOperation = new Map<string, number>();
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: true },
      async generate(request) {
        const attempt = (attemptsByOperation.get(request.operation) ?? 0) + 1;
        attemptsByOperation.set(request.operation, attempt);
        const output = attempt < 3 ? { stakeholders: [{ role: 'buyer' }] } : { stakeholders: [] };
        return { text: JSON.stringify(output), output };
      }
    };
    const gateway = createTestGateway(transport);
    const request = (operation: string) => ({
      schema,
      messages: [{ role: 'user' as const, content: 'Extract.' }],
      operation,
      limits: { maxCalls: 3, maxSchemaRepairs: 2, maxTransportRetries: 0, deadlineMs: 1_000 }
    });

    await expect(gateway.generateObject(request('specialist-one'))).resolves.toMatchObject({ value: { stakeholders: [] } });
    await expect(gateway.generateObject(request('specialist-two'))).resolves.toMatchObject({ value: { stakeholders: [] } });
    expect(attemptsByOperation).toEqual(new Map([['specialist-one', 3], ['specialist-two', 3]]));
  });

  it('releases only trusted not-sent failures and conservatively charges ambiguous transport failures', async () => {
    const outcomes: string[] = [];
    let ordinal = 0;
    const ledger: ProviderAttemptLedger = {
      async beginAttempt() { ordinal += 1; return { reservationId: `reservation-${ordinal}`, attemptId: `attempt-${ordinal}`, ordinal, grantedOutputTokens: 50 }; },
      async settleAttempt() { outcomes.push('settled'); },
      async releaseAttempt(input) { outcomes.push(input.disposition); }
    };
    let call = 0;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() {
        call += 1;
        throw new ModelGatewayTransportError({ category: 'transient_transport', delivery: call === 1 ? 'safe_not_sent' : undefined });
      }
    };
    const gateway = createBudgetedModelGateway(transport, undefined, ledger);
    const request = {
      schema, messages: [{ role: 'user' as const, content: 'Extract.' }], operation: 'durable-delivery',
      durableAttempt: { runScope: 'run-durable', provider: 'mock', model: 'mock-chat' },
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 100 }
    };
    await expect(gateway.generateObject(request)).rejects.toThrow('transport');
    await expect(gateway.generateObject(request)).rejects.toThrow('transport');
    expect(outcomes).toEqual(['safe_not_sent', 'possibly_sent']);
  });

  it('returns normalized Zod issues to the model before succeeding', async () => {
    const calls: TransportGeneration[] = [];
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate(request) {
        calls.push({ text: request.messages.at(-1)?.content ?? '' });
        return calls.length === 1
          ? { text: '{"stakeholders":[{"role":"buyer"}]}', usage: { outputTokens: 10 } }
          : { text: '{"stakeholders":[{"role":"champion"}]}', usage: { outputTokens: 10 } };
      }
    };
    const gateway = createTestGateway(transport);

    const result = await gateway.generateObject({
      schema,
      messages: [{ role: 'user', content: 'Extract stakeholders.' }],
      operation: 'contract-test',
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 200 }
    });

    expect(result.value).toEqual({ stakeholders: [{ role: 'champion' }] });
    expect(result.attempts).toHaveLength(2);
    expect(calls[1]?.text).toContain('stakeholders.0.role');
    expect(calls[1]?.text).toContain('BEGIN_UNTRUSTED_INVALID_OUTPUT');
    expect(result.outputMode).toBe('prompted_json');
  });

  it('rejects multiple top-level JSON values instead of accepting a prefix', async () => {
    const outputs = ['{"stakeholders":[]}{"stakeholders":[]}', '{"stakeholders":[]}'];
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() { return { text: outputs.shift() ?? '', usage: { outputTokens: 10 } }; }
    };

    const result = await createTestGateway(transport).generateObject({
      schema,
      messages: [{ role: 'user', content: 'Extract stakeholders.' }],
      operation: 'strict-json',
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 200 }
    });

    expect(result.value).toEqual({ stakeholders: [] });
    expect(result.attempts).toHaveLength(2);
  });

  it.each([
    ['Unicode non-JSON whitespace', '\u00a0{"stakeholders":[]}'],
    ['excessive nesting', `${'['.repeat(34)}${']'.repeat(34)}`],
    ['excessive nodes', `[${'0,'.repeat(10_000)}0]`]
  ])('repairs %s without accepting unsafe JSON', async (_name, invalid) => {
    const outputs = [invalid, '{"stakeholders":[]}'];
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() { return { text: outputs.shift() ?? '', usage: { outputTokens: 10 } }; }
    };

    const result = await createTestGateway(transport).generateObject({
      schema,
      messages: [{ role: 'user', content: 'Extract stakeholders.' }],
      operation: 'strict-json-security',
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 200_000, maxOutputTokens: 200 }
    });

    expect(result.value).toEqual({ stakeholders: [] });
    expect(result.attempts).toHaveLength(2);
  });

  it('rejects prototype setter JSON before inherited values can satisfy a schema', async () => {
    const inheritedSchema = z.object({ stakeholders: z.array(z.unknown()).optional() }).strict();
    const outputs = ['{"__proto__":{"stakeholders":[]}}', '{}'];
    const transport: ModelTransport = { capabilities: { nativeStructuredOutput: false }, async generate() { return { text: outputs.shift() ?? '', usage: { outputTokens: 10 } }; } };

    const result = await createTestGateway(transport).generateObject({
      schema: inheritedSchema, messages: [{ role: 'user', content: 'Return JSON.' }], operation: 'prototype-security',
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 100 }
    });

    expect(result.value).toEqual({});
    expect(result.attempts).toHaveLength(2);
  });

  it('uses native schema mode when the capability is proven', async () => {
    let receivedSchema = false;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: true },
      async generate(request) { receivedSchema = request.schema === schema; return { output: { stakeholders: [] }, usage: { outputTokens: 10 } }; }
    };

    const result = await createTestGateway(transport).generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'native-schema',
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 100 }
    });

    expect(receivedSchema).toBe(true);
    expect(result.outputMode).toBe('native_schema');
  });

  it('sends native-schema validation issues and the complete failed output on repair', async () => {
    const failedOutput = `${'x'.repeat(20 * 1024)}END_OF_FAILED_OUTPUT`;
    const requests: string[] = [];
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: true },
      async generate(request) {
        requests.push(request.messages.at(-1)?.content ?? '');
        return requests.length === 1
          ? { text: failedOutput, output: { stakeholders: [{ role: 'buyer' }] }, usage: { outputTokens: 10 } }
          : { text: '{"stakeholders":[]}', output: { stakeholders: [] }, usage: { outputTokens: 10 } };
      }
    };

    const result = await createTestGateway(transport).generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'native-schema-repair',
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 100_000, maxOutputTokens: 200 }
    });

    expect(result.value).toEqual({ stakeholders: [] });
    expect(requests[1]).toContain('stakeholders.0.role');
    expect(requests[1]).toContain(failedOutput);
    expect(requests[1]).toContain('END_OF_FAILED_OUTPUT');
  });

  it('records rejected identifier values in validation diagnostics', async () => {
    const identifierSchema = z.object({ evidenceId: z.string().regex(/^evidence_/) }).strict();
    const recorded: Array<readonly { path: string; code: string; message: string }[]> = [];
    let ordinal = 0;
    const ledger: ProviderAttemptLedger = {
      async beginAttempt(input) {
        ordinal += 1;
        return { reservationId: `identifier-${ordinal}`, attemptId: `identifier-${ordinal}`, ordinal, grantedOutputTokens: input.requestedOutputTokens };
      },
      async settleAttempt() {},
      async releaseAttempt() {},
      async recordAttemptMetadata(input) { recorded.push(input.validationIssues); }
    };
    let call = 0;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: true },
      async generate() {
        call += 1;
        const output = call === 1 ? { evidenceId: 'document_wrong' } : { evidenceId: 'evidence_right' };
        return { text: JSON.stringify(output), output };
      }
    };

    await createBudgetedModelGateway(transport, undefined, ledger).generateObject({
      schema: identifierSchema,
      messages: [{ role: 'user', content: 'Select evidence.' }],
      operation: 'identifier-diagnostics',
      durableAttempt: { runScope: 'run-identifiers', provider: 'mock', model: 'mock-chat' },
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000 }
    });

    expect(recorded[0]?.[0]?.message).toContain('document_wrong');
  });

  it('fails explicitly instead of truncating repair feedback that cannot fit the context window', async () => {
    let calls = 0;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: true },
      async generate() {
        calls += 1;
        return { text: 'x'.repeat(800), output: { stakeholders: [{ role: 'buyer' }] }, usage: { outputTokens: 10 } };
      }
    };
    const policy = new ContextWindowPolicy({
      contextWindowTokens: 128,
      reservedOutputTokens: 32,
      sectionTokenBudgets: { instructions: 16, currentTask: 16, evidence: 16, artifacts: 16, history: 16 }
    });

    await expect(createTestGateway(transport, policy).generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'oversized-native-repair',
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 200 }
    })).rejects.toThrow('Complete repair feedback exceeds available input capacity');
    expect(calls).toBe(1);
  });

  it('enforces a shared budget across independent specialist calls', async () => {
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() { return { text: '{"stakeholders":[]}', usage: { inputTokens: 1, outputTokens: 1 } }; }
    };
    const shared = new RunBudgetLedger({ scope: 'run_1', maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, deadlineMs: 1_000 });
    const gateway = createTestGateway(transport);
    const request = { schema, messages: [{ role: 'user' as const, content: 'Extract.' }], operation: 'shared-budget', budget: shared,
      limits: { maxCalls: 2, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 100 } };

    await gateway.generateObject(request);
    await expect(gateway.generateObject(request)).rejects.toThrow('call limit');
  });

  it('does not impose an app-defined output-token ceiling on concurrent provider calls', async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() {
        calls += 1;
        return new Promise((resolve) => releases.push(() => resolve({ text: '{"stakeholders":[]}', usage: { outputTokens: 100 } })));
      }
    };
    const shared = new RunBudgetLedger({ scope: 'run_output', maxCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 100, deadlineMs: 1_000 });
    const gateway = createTestGateway(transport);
    const request = { schema, messages: [{ role: 'user' as const, content: 'Extract.' }], operation: 'shared-output', budget: shared,
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 1_000, maxOutputTokens: 100 } };

    const first = gateway.generateObject(request);
    const second = gateway.generateObject(request);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    releases.forEach((release) => release());

    await expect(first).resolves.toMatchObject({ value: { stakeholders: [] } });
    await expect(second).resolves.toMatchObject({ value: { stakeholders: [] } });
  });

  it('releases output capacity after a transport failure while retaining the call charge', async () => {
    let calls = 0;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() {
        calls += 1;
        if (calls === 1) throw new ModelGatewayTransportError({ category: 'transient_transport', diagnosticCode: 'ECONNRESET' });
        return { text: '{"stakeholders":[]}', usage: { outputTokens: 10 } };
      }
    };
    const shared = new RunBudgetLedger({ scope: 'run_release', maxCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 100, deadlineMs: 1_000 });
    const gateway = createTestGateway(transport);
    const request = { schema, messages: [{ role: 'user' as const, content: 'Extract.' }], operation: 'release-output', budget: shared,
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 1_000, maxOutputTokens: 100 } };

    await expect(gateway.generateObject(request)).rejects.toMatchObject({ normalized: { category: 'transient_transport' } });
    await expect(gateway.generateObject(request)).resolves.toMatchObject({ value: { stakeholders: [] } });
    expect(calls).toBe(2);
  });

  it('fails a slow successful provider response after the deadline', async () => {
    vi.useFakeTimers();
    let resolve: ((value: TransportGeneration) => void) | undefined;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() { return new Promise((done) => { resolve = done; }); }
    };
    const pending = createTestGateway(transport).generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'deadline',
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1, maxInputTokens: 10_000, maxOutputTokens: 100 }
    });
    await vi.advanceTimersByTimeAsync(2);
    resolve?.({ text: '{"stakeholders":[]}' });

    await expect(pending).rejects.toThrow('deadline');
    vi.useRealTimers();
  });

  it('records provider input usage without imposing an app-defined token budget', async () => {
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() { return { text: '{"stakeholders":[]}', usage: { inputTokens: 2_000, outputTokens: 1 } }; }
    };

    await expect(createTestGateway(transport).generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'actual-input-budget',
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 1_000, maxOutputTokens: 100 }
    })).resolves.toMatchObject({ usage: { inputTokens: 2_000 } });
  });

  it('retains context invariants when corrective feedback is added', async () => {
    const received: string[] = [];
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate(request) {
        received.push(request.messages.map((message) => message.content).join('\n'));
        return received.length === 1
          ? { text: '{"stakeholders":[{"role":"bad"}]}', usage: { outputTokens: 10 } }
          : { text: '{"stakeholders":[]}', usage: { outputTokens: 10 } };
      }
    };
    const policy = new (await import('@slacato/core')).ContextWindowPolicy({
      contextWindowTokens: 1_000, reservedOutputTokens: 20,
      sectionTokenBudgets: { instructions: 8, currentTask: 8, evidence: 8, artifacts: 8, history: 8 }
    });
    await createTestGateway(transport, policy).generateObject({
      schema, messages: [], operation: 'repair-invariants',
      context: { instructions: 'INSTRUCT', currentTask: 'TASK', evidence: [{ id: 'e1', content: 'evidence' }] },
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 100 }
    });

    expect(received[1]).toContain('INSTRUCT');
    expect(received[1]).toContain('TASK');
    expect(received[1]).toContain('e1');
  });
});
