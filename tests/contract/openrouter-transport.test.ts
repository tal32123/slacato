import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ProviderAttemptLedger } from '@slacato/core';
import { createOpenRouterModelGateways } from '@slacato/infrastructure';

const ledger: ProviderAttemptLedger = {
  async beginAttempt() {
    return { reservationId: 'reservation', attemptId: 'attempt', ordinal: 1, grantedOutputTokens: 64 };
  },
  async settleAttempt() {},
  async releaseAttempt() {}
};

describe('OpenRouter transport', () => {
  it('uses strict JSON schema generation and the embeddings endpoint through one provider', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = input.toString();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body, headers: new Headers(init?.headers) });
      if (url.endsWith('/embeddings')) {
        return Response.json({
          object: 'list', model: 'openai/text-embedding-3-small',
          data: [
            { object: 'embedding', index: 0, embedding: [1, 0, 0] },
            { object: 'embedding', index: 1, embedding: [0, 1, 0] }
          ],
          usage: { prompt_tokens: 4, total_tokens: 4 }
        });
      }
      return Response.json({
        id: 'generation-1', object: 'chat.completion', created: 1, model: 'openai/gpt-5.6-luna',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"ready":true}' }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
      });
    };
    const gateways = createOpenRouterModelGateways({
      apiKey: 'secret', generationModelId: 'openai/gpt-5.6-luna',
      embeddingModelId: 'openai/text-embedding-3-small', attemptLedger: ledger, fetch: fakeFetch
    });

    const generated = await gateways.modelGateway.generateObject({
      schema: z.object({ ready: z.literal(true) }).strict(),
      messages: [{ role: 'user', content: 'Report readiness.' }], operation: 'contract-probe',
      durableAttempt: { runScope: 'probe', provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 1_000, maxOutputTokens: 64 }
    });
    const embeddings = await gateways.embeddingGateway.embed(['first', 'second']);

    expect(generated.value).toEqual({ ready: true });
    expect(embeddings).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      body: {
        model: 'openai/gpt-5.6-luna',
        response_format: { type: 'json_schema', json_schema: { strict: true } },
        provider: { allow_fallbacks: true, require_parameters: true }
      }
    });
    expect(requests[0]?.headers.get('x-openrouter-title')).toBe('SlaCato');
    expect(requests[1]).toMatchObject({
      url: 'https://openrouter.ai/api/v1/embeddings',
      body: { model: 'openai/text-embedding-3-small', input: ['first', 'second'] }
    });
  });
});
