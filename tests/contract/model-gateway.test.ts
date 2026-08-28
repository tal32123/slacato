import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  createBudgetedModelGateway,
  type ModelTransport,
  type TransportGeneration
} from '@slacato/core';

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
          ? { text: '{"stakeholders":[{"role":"buyer"}]}' }
          : { text: '{"stakeholders":[{"role":"champion"}]}' };
      }
    };
    const gateway = createBudgetedModelGateway(transport);

    const result = await gateway.generateObject({
      schema,
      messages: [{ role: 'user', content: 'Extract stakeholders.' }],
      operation: 'contract-test',
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxOutputTokens: 200 }
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
      async generate() { return { text: outputs.shift() ?? '' }; }
    };

    const result = await createBudgetedModelGateway(transport).generateObject({
      schema,
      messages: [{ role: 'user', content: 'Extract stakeholders.' }],
      operation: 'strict-json',
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxOutputTokens: 200 }
    });

    expect(result.value).toEqual({ stakeholders: [] });
    expect(result.attempts).toHaveLength(2);
  });
});
