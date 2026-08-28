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
    const fakeGateway: NonRecursiveCompactionGateway = {
      async compact(input) {
        expect(input.mode).toBe('non_recursive');
        return {
          coveredMessageRange: { from: 0, to: 0 }, summary: 'checkpoint', scopeHash: 'scope', policyHash: 'policy',
          evidenceHash: 'evidence', promptHash: 'prompt', schemaHash: 'schema', modelHash: 'model', validationHash: 'valid'
        };
      }
    };
    const compactor = createNonRecursiveContextCompactor(fakeGateway);

    const checkpoint = await compactor.compact({ history, maxInputTokens: 20, maxOutputTokens: 10, priorInvocations: 0 });

    expect(checkpoint.summary).toBe('checkpoint');
    expect(history).toEqual([{ role: 'user', content: 'raw history' }]);
  });

  it('rejects a checkpoint when the authorization scope narrows', () => {
    const checkpoint = {
      coveredMessageRange: { from: 0, to: 0 }, summary: 'checkpoint', scopeHash: 'old-scope', policyHash: 'policy',
      evidenceHash: 'evidence', promptHash: 'prompt', schemaHash: 'schema', modelHash: 'model', validationHash: 'valid'
    } as const;

    expect(isContextCheckpointReusable(checkpoint, { ...checkpoint, scopeHash: 'old-scope' })).toBe(true);
    expect(isContextCheckpointReusable(checkpoint, { ...checkpoint, scopeHash: 'narrower-scope' })).toBe(false);
  });
});
