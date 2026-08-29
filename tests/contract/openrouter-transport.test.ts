import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ProviderAttemptLedger } from '@slacato/core';
import { createOpenRouterModelGateways, providerJsonSchema } from '../../packages/infrastructure/src/model/openrouter.ts';
import { openRouterDiagnosticCode } from '../../packages/infrastructure/src/model/openrouter-diagnostics.ts';

const ledger: ProviderAttemptLedger = {
  async beginAttempt() {
    return { reservationId: 'reservation', attemptId: 'attempt', ordinal: 1, grantedOutputTokens: 64 };
  },
  async settleAttempt() {},
  async releaseAttempt() {}
};

describe('OpenRouter transport', () => {
  it('preserves a safe provider error code for actionable diagnostics', () => {
    expect(openRouterDiagnosticCode(400, JSON.stringify({
      error: { code: 400, message: 'Provider returned error', metadata: {
        raw: JSON.stringify({ error: { message: 'Invalid JSON schema: unsupported format' } })
      } }
    }))).toBe('openrouter_400_invalid_json_schema_unsupported_format');
  });

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
      messages: [
        { role: 'system', content: 'Follow the readiness contract.' },
        { role: 'user', content: 'Report readiness.' }
      ], operation: 'contract-probe',
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
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Follow the readiness contract.' }] },
          { role: 'user', content: 'Report readiness.' }
        ],
        response_format: { type: 'json_schema', json_schema: { strict: true } },
        provider: { allow_fallbacks: true, require_parameters: true }
      }
    });
    expect(requests[0]?.body).not.toHaveProperty('max_tokens');
    expect(requests[0]?.headers.get('x-openrouter-title')).toBe('SlaCato');
    expect(requests[1]).toMatchObject({
      url: 'https://openrouter.ai/api/v1/embeddings',
      body: { model: 'openai/text-embedding-3-small', input: ['first', 'second'] }
    });
  });

  it('omits JSON Schema string constraints unsupported by Gemini while retaining local validation', async () => {
    expect(JSON.stringify(providerJsonSchema(z.toJSONSchema(
      z.object({ code: z.string().min(2).max(8).regex(/^[A-Z]+$/) }).strict(), { io: 'input' }
    )))).not.toContain('minLength');
    let body: Record<string, unknown> = {};
    const fakeFetch: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: 'generation-schema', object: 'chat.completion', created: 1, model: 'google/gemini-3.5-flash-lite',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"code":"ABC"}' }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
    };
    const gateways = createOpenRouterModelGateways({
      apiKey: 'secret', generationModelId: 'google/gemini-3.5-flash-lite',
      embeddingModelId: 'openai/text-embedding-3-small', attemptLedger: ledger, fetch: fakeFetch
    });

    await gateways.modelGateway.generateObject({
      schema: z.object({ code: z.string().min(2).max(8).regex(/^[A-Z]+$/) }).strict(),
      messages: [{ role: 'user', content: 'Return a code.' }], operation: 'gemini-schema-probe',
      durableAttempt: { runScope: 'gemini-schema-probe', provider: 'openrouter', model: 'google/gemini-3.5-flash-lite' },
      limits: { maxCalls: 1, maxSchemaRepairs: 0, maxTransportRetries: 0, deadlineMs: 1_000 }
    });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('minLength');
    expect(serialized).not.toContain('maxLength');
    expect(serialized).not.toContain('pattern');
    expect(serialized).not.toContain('maxItems');
  });

  it('repairs a reasoning-only length response instead of hiding it as unknown', async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return Response.json({
        id: `generation-${calls}`, object: 'chat.completion', created: calls,
        model: 'dots-studio/dots-3-note-preview:free',
        choices: [{
          index: 0,
          message: calls === 1
            ? { role: 'assistant', content: null, reasoning: 'still reasoning' }
            : { role: 'assistant', content: '{"ready":true}' },
          finish_reason: calls === 1 ? 'length' : 'stop',
          logprobs: null
        }],
        usage: { prompt_tokens: 20, completion_tokens: 64, total_tokens: 84 }
      });
    };
    const gateways = createOpenRouterModelGateways({
      apiKey: 'secret', generationModelId: 'dots-studio/dots-3-note-preview:free',
      embeddingModelId: 'openai/text-embedding-3-small', attemptLedger: ledger, fetch: fakeFetch
    });

    await expect(gateways.modelGateway.generateObject({
      schema: z.object({ ready: z.boolean() }).strict(),
      messages: [{ role: 'user', content: 'Report readiness.' }], operation: 'length-probe',
      durableAttempt: { runScope: 'length-probe', provider: 'openrouter', model: 'dots-studio/dots-3-note-preview:free' },
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 128 }
    })).resolves.toMatchObject({ value: { ready: true } });
    expect(calls).toBe(2);
  });

  it('preserves invalid native output so the gateway can send an informed repair', async () => {
    let calls = 0;
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        id: `generation-${calls}`, object: 'chat.completion', created: calls,
        model: 'dots-studio/dots-3-note-preview:free',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: calls === 1 ? '{"ready":not-a-boolean}' : '{"ready":true}' },
          finish_reason: 'stop', logprobs: null
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
      });
    };
    const gateways = createOpenRouterModelGateways({
      apiKey: 'secret', generationModelId: 'dots-studio/dots-3-note-preview:free',
      embeddingModelId: 'openai/text-embedding-3-small', attemptLedger: ledger, fetch: fakeFetch
    });

    const result = await gateways.modelGateway.generateObject({
      schema: z.object({ ready: z.boolean() }).strict(),
      messages: [{ role: 'user', content: 'Report readiness.' }], operation: 'native-repair-probe',
      durableAttempt: { runScope: 'native-repair-probe', provider: 'openrouter', model: 'dots-studio/dots-3-note-preview:free' },
      limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 1_000, maxInputTokens: 10_000, maxOutputTokens: 128 }
    });

    expect(result.value).toEqual({ ready: true });
    expect(calls).toBe(2);
    expect(JSON.stringify(bodies[1]?.messages)).toContain('not-a-boolean');
    expect(JSON.stringify(bodies[1]?.messages)).toContain('ready');
  });
});
