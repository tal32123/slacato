import { describe, expect, it } from 'vitest';
import {
  ContextWindowPolicy,
  createNonRecursiveContextCompactor,
  isContextCheckpointReusable,
  type NonRecursiveCompactionGateway
} from '@slacato/core';

describe('ContextWindowPolicy', () => {
  it('retains instructions, current task, evidence IDs, and recent history within its deterministic budget', () => {
    const input = {
      instructions: 'Follow the validated output schema.',
      currentTask: 'Summarize the authorized evidence.',
      evidence: [
        { id: 'evidence_1', content: 'A'.repeat(1_000) },
        { id: 'evidence_2', content: 'B'.repeat(1_000) }
      ],
      artifacts: [{ id: 'artifact_1', content: 'C'.repeat(1_000) }],
      history: [
        { role: 'user' as const, content: 'old '.repeat(300) },
        { role: 'assistant' as const, content: 'recent '.repeat(60) }
      ]
    };
    const original = structuredClone(input);
    const policy = new ContextWindowPolicy({
      contextWindowTokens: 200,
      reservedOutputTokens: 40,
      sectionTokenBudgets: { instructions: 30, currentTask: 30, evidence: 45, artifacts: 25, history: 30 }
    });

    const prepared = policy.prepare(input);

    expect(prepared.messages[0]).toEqual({ role: 'system', content: input.instructions });
    expect(prepared.messages.some((message) => message.content.includes('evidence_1'))).toBe(true);
    expect(prepared.messages.at(-1)?.content).toContain('recent');
    expect(prepared.inputTokens).toBeLessThanOrEqual(160);
    expect(input).toEqual(original);
  });

  it('uses a non-recursive compaction gateway once and leaves raw history unchanged', async () => {
    const history = [{ role: 'user' as const, content: 'raw history' }];
    const bindings = { scopeHash: 'scope', policyHash: 'policy', evidenceHash: 'evidence', promptHash: 'prompt', schemaHash: 'schema', modelHash: 'model', validationHash: 'valid' } as const;
    const fakeGateway: NonRecursiveCompactionGateway = {
      async compact(input) {
        expect(input.mode).toBe('non_recursive');
        return {
          coveredMessageRange: { from: 0, to: 0 }, summary: 'checkpoint', ...bindings, validationState: 'validated'
        };
      }
    };
    const compactor = createNonRecursiveContextCompactor(fakeGateway, new ContextWindowPolicy({
      contextWindowTokens: 30, reservedOutputTokens: 4,
      sectionTokenBudgets: { instructions: 4, currentTask: 8, evidence: 0, artifacts: 0, history: 4 }
    }));

    const checkpoint = await compactor.compact({ history, context: { instructions: 'ok', currentTask: 'ok' }, maxInputTokens: 20, maxOutputTokens: 10, priorInvocations: 0, maxSteps: 1, maxRetries: 0, coveredMessageRange: { from: 0, to: 0 }, bindings });

    expect(checkpoint.summary).toBe('checkpoint');
    expect(history).toEqual([{ role: 'user', content: 'raw history' }]);
  });

  it('rejects a checkpoint when the authorization scope narrows', () => {
    const checkpoint = {
      coveredMessageRange: { from: 0, to: 0 }, summary: 'checkpoint', scopeHash: 'old-scope', policyHash: 'policy',
      evidenceHash: 'evidence', promptHash: 'prompt', schemaHash: 'schema', modelHash: 'model', validationHash: 'valid', validationState: 'validated'
    } as const;

    expect(isContextCheckpointReusable(checkpoint, { ...checkpoint, scopeHash: 'old-scope' })).toBe(true);
    expect(isContextCheckpointReusable(checkpoint, { ...checkpoint, scopeHash: 'narrower-scope' })).toBe(false);
  });

  it('fails deterministically when an oversized evidence ID cannot fit its invariant budget', () => {
    const policy = new ContextWindowPolicy({
      contextWindowTokens: 20, reservedOutputTokens: 4,
      sectionTokenBudgets: { instructions: 2, currentTask: 2, evidence: 2, artifacts: 2, history: 2 }
    });

    expect(() => policy.prepare({ instructions: 'ok', currentTask: 'ok', evidence: [{ id: 'evidence_identifier_that_cannot_fit', content: '' }] })).toThrow('invariant');
  });

  it('rejects malformed checkpoints and never forwards huge raw history beyond maxInputTokens', async () => {
    let calls = 0;
    const policy = new ContextWindowPolicy({
      contextWindowTokens: 8, reservedOutputTokens: 4,
      sectionTokenBudgets: { instructions: 1, currentTask: 1, evidence: 0, artifacts: 0, history: 1 }
    });
    const compactor = createNonRecursiveContextCompactor({
      async compact() {
        calls += 1;
        return { coveredMessageRange: { from: -1, to: 0 }, summary: '', scopeHash: '', policyHash: '', evidenceHash: '', promptHash: '', schemaHash: '', modelHash: '', validationHash: '' };
      }
    }, policy);
    const history = [{ role: 'user' as const, content: 'x'.repeat(10_000) }];

    await expect(compactor.compact({ history, context: { instructions: '', currentTask: '' }, maxInputTokens: 1, maxOutputTokens: 1, priorInvocations: 0, maxSteps: 1, maxRetries: 0, coveredMessageRange: { from: 0, to: 0 }, bindings: { scopeHash: 'scope', policyHash: 'policy', evidenceHash: 'evidence', promptHash: 'prompt', schemaHash: 'schema', modelHash: 'model', validationHash: 'valid' } })).rejects.toThrow('input');
    expect(calls).toBe(0);
    expect(history[0]?.content).toHaveLength(10_000);
  });

  it('rejects malformed compactor results and repeated or multi-step compaction', async () => {
    const policy = new ContextWindowPolicy({
      contextWindowTokens: 40, reservedOutputTokens: 4,
      sectionTokenBudgets: { instructions: 4, currentTask: 8, evidence: 0, artifacts: 0, history: 4 }
    });
    const bindings = { scopeHash: 'scope', policyHash: 'policy', evidenceHash: 'evidence', promptHash: 'prompt', schemaHash: 'schema', modelHash: 'model', validationHash: 'valid' } as const;
    const base = { history: [{ role: 'user' as const, content: 'raw' }], context: { instructions: 'ok', currentTask: 'ok' }, maxInputTokens: 20, maxOutputTokens: 10, priorInvocations: 0, maxSteps: 1 as const, maxRetries: 0 as const, coveredMessageRange: { from: 0, to: 0 }, bindings };
    const malformed = createNonRecursiveContextCompactor({
      async compact() { return { coveredMessageRange: { from: 0, to: 0 }, summary: 'bad', ...bindings, validationState: 'invalid' as unknown as 'validated' }; }
    }, policy);

    await expect(malformed.compact(base)).rejects.toThrow('unvalidated');
    await expect(malformed.compact({ ...base, priorInvocations: 1 })).rejects.toThrow('Repeated');
    await expect(malformed.compact({ ...base, maxSteps: 2 as unknown as 1 })).rejects.toThrow('exactly one step');
  });
});
