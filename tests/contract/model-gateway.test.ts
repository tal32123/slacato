import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  createBudgetedModelGateway,
  RunBudgetLedger,
  type ModelTransport,
  type TransportGeneration
} from '@slacato/core';
import { vi } from 'vitest';

const schema = z.object({
  stakeholders: z.array(z.object({ role: z.enum(['champion', 'economic_buyer']) }))
}).strict();

describe('BudgetedModelGateway', () => {
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
    const gateway = createBudgetedModelGateway(transport);

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

    const result = await createBudgetedModelGateway(transport).generateObject({
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
    ['excessive nodes', `[${'0,'.repeat(10_000)}0]`],
    ['oversized output', `${'{"stakeholders":[]}'}${' '.repeat(128 * 1024)}`]
  ])('repairs %s without accepting unsafe JSON', async (_name, invalid) => {
    const outputs = [invalid, '{"stakeholders":[]}'];
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() { return { text: outputs.shift() ?? '', usage: { outputTokens: 10 } }; }
    };

    const result = await createBudgetedModelGateway(transport).generateObject({
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

    const result = await createBudgetedModelGateway(transport).generateObject({
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

    const result = await createBudgetedModelGateway(transport).generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'native-schema',
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 100 }
    });

    expect(receivedSchema).toBe(true);
    expect(result.outputMode).toBe('native_schema');
  });

  it('enforces a shared budget across independent specialist calls', async () => {
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() { return { text: '{"stakeholders":[]}', usage: { inputTokens: 1, outputTokens: 1 } }; }
    };
    const shared = new RunBudgetLedger({ scope: 'run_1', maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, deadlineMs: 1_000 });
    const gateway = createBudgetedModelGateway(transport);
    const request = { schema, messages: [{ role: 'user' as const, content: 'Extract.' }], operation: 'shared-budget', budget: shared,
      limits: { maxCalls: 2, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 100 } };

    await gateway.generateObject(request);
    await expect(gateway.generateObject(request)).rejects.toThrow('call limit');
  });

  it('reserves shared output capacity before concurrent provider calls', async () => {
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
    const gateway = createBudgetedModelGateway(transport);
    const request = { schema, messages: [{ role: 'user' as const, content: 'Extract.' }], operation: 'shared-output', budget: shared,
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 1_000, maxOutputTokens: 100 } };

    const first = gateway.generateObject(request);
    const second = gateway.generateObject(request);
    expect(calls).toBe(1);
    releases.forEach((release) => release());

    await expect(first).resolves.toMatchObject({ value: { stakeholders: [] } });
    await expect(second).rejects.toThrow('output token budget');
  });

  it('releases output capacity after a transport failure while retaining the call charge', async () => {
    let calls = 0;
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() {
        calls += 1;
        if (calls === 1) throw { category: 'transient_transport', code: 'ECONNRESET' };
        return { text: '{"stakeholders":[]}', usage: { outputTokens: 10 } };
      }
    };
    const shared = new RunBudgetLedger({ scope: 'run_release', maxCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 100, deadlineMs: 1_000 });
    const gateway = createBudgetedModelGateway(transport);
    const request = { schema, messages: [{ role: 'user' as const, content: 'Extract.' }], operation: 'release-output', budget: shared,
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 1_000, maxOutputTokens: 100 } };

    await expect(gateway.generateObject(request)).rejects.toEqual(expect.objectContaining({ category: 'transient_transport' }));
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
    const pending = createBudgetedModelGateway(transport).generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'deadline',
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1, maxInputTokens: 10_000, maxOutputTokens: 100 }
    });
    await vi.advanceTimersByTimeAsync(2);
    resolve?.({ text: '{"stakeholders":[]}' });

    await expect(pending).rejects.toThrow('deadline');
    vi.useRealTimers();
  });

  it('rejects provider-reported input usage that exceeds the reserved hard budget', async () => {
    const transport: ModelTransport = {
      capabilities: { nativeStructuredOutput: false },
      async generate() { return { text: '{"stakeholders":[]}', usage: { inputTokens: 2_000, outputTokens: 1 } }; }
    };

    await expect(createBudgetedModelGateway(transport).generateObject({
      schema, messages: [{ role: 'user', content: 'Extract.' }], operation: 'actual-input-budget',
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 1_000, maxOutputTokens: 100 }
    })).rejects.toThrow('Input token budget');
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
      contextWindowTokens: 100, reservedOutputTokens: 20,
      sectionTokenBudgets: { instructions: 8, currentTask: 8, evidence: 8, artifacts: 8, history: 8 }
    });
    await createBudgetedModelGateway(transport, policy).generateObject({
      schema, messages: [], operation: 'repair-invariants',
      context: { instructions: 'INSTRUCT', currentTask: 'TASK', evidence: [{ id: 'e1', content: 'evidence' }] },
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 100 }
    });

    expect(received[1]).toContain('INSTRUCT');
    expect(received[1]).toContain('TASK');
    expect(received[1]).toContain('e1');
  });
});
