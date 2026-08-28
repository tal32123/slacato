import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMockModelGateways, MOCK_EMBEDDING_DIMENSION, MOCK_EMBEDDING_PROFILE } from '@slacato/infrastructure/model/mock';
import type { ProviderAttemptLedger } from '@slacato/core';

const schema = z.object({ stakeholders: z.array(z.object({ role: z.enum(['champion']) })) }).strict();
const fixtureLedger: ProviderAttemptLedger = {
  async beginAttempt() { return { reservationId: crypto.randomUUID(), attemptId: crypto.randomUUID(), ordinal: 1, grantedOutputTokens: 100 }; },
  async settleAttempt() {}, async releaseAttempt() {}
};

describe('deterministic mock model provider', () => {
  it('runs scripted invalid then valid output through the real schema-repair gateway', async () => {
    const requests: string[] = [];
    const outputs = ['{"stakeholders":[{"role":"buyer"}]}', '{"stakeholders":[{"role":"champion"}]}'];
    const { modelGateway, registry } = createMockModelGateways({
      attemptLedger: fixtureLedger,
      resolve: async (request) => {
        requests.push(request.messages.map((message) => message.content).join('\n'));
        return { text: outputs.shift() ?? '{}', usage: { inputTokens: 1, outputTokens: 1 } };
      }
    });

    const result = await modelGateway.generateObject({
      schema, messages: [{ role: 'user', content: 'Extract stakeholders.' }], operation: 'mock-repair',
      durableAttempt: { runScope: 'fixture-run', provider: 'mock', model: 'mock-specialist' },
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 100 }
    });

    expect(result.value).toEqual({ stakeholders: [{ role: 'champion' }] });
    expect(result.attempts).toHaveLength(2);
    expect(requests[1]).toContain('BEGIN_UNTRUSTED_INVALID_OUTPUT');
    expect(result.warnings).toContain('mock_provider');
    expect(registry.resolve('brief')).toMatchObject({ providerId: 'mock', modelId: 'mock-brief' });
    expect(registry.resolve('embedding')).toMatchObject({ providerId: 'mock', modelId: 'mock-embedding' });
  });

  it('creates stable, normalized, fixed-profile embeddings without network state', async () => {
    const { embeddingGateway } = createMockModelGateways({ resolve: async () => ({ text: '{}' }), attemptLedger: fixtureLedger });
    const [first, second, different, empty, whitespace] = await embeddingGateway.embed(['alpha beta', 'alpha beta', 'gamma delta', '', '   ']);

    expect(MOCK_EMBEDDING_PROFILE).toMatchObject({ providerId: 'mock', modelId: 'mock-embedding', dimension: 64, unitNormalized: true });
    expect(MOCK_EMBEDDING_DIMENSION).toBe(64);
    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
    expect(first).toHaveLength(MOCK_EMBEDDING_DIMENSION);
    expect(vectorMagnitude(first!)).toBeCloseTo(1, 12);
    expect(empty).toEqual(Array(MOCK_EMBEDDING_DIMENSION).fill(0));
    expect(whitespace).toEqual(Array(MOCK_EMBEDDING_DIMENSION).fill(0));
  });

  it('normalizes the known signed-hash collision input instead of cancelling it to zero', async () => {
    const { embeddingGateway } = createMockModelGateways({ resolve: async () => ({ text: '{}' }), attemptLedger: fixtureLedger });
    const [collision] = await embeddingGateway.embed(['token9 token12']);

    expect(collision).not.toEqual(Array(MOCK_EMBEDDING_DIMENSION).fill(0));
    expect(vectorMagnitude(collision!)).toBeCloseTo(1, 12);
  });
});

function vectorMagnitude(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}
