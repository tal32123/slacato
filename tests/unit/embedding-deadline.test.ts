import type { EmbeddingGateway, RunBudgetLimits } from '@slacato/core';
import { describe, expect, it } from 'vitest';
import type { PostgresProviderAttemptLedger } from '../../packages/infrastructure/src/db/repositories/provider-attempt-ledger.ts';
import { createOllamaModelGateways } from '../../packages/infrastructure/src/model/ollama.ts';
import { createOpenRouterModelGateways } from '../../packages/infrastructure/src/model/openrouter.ts';
import { runScopedEmbedding } from '../../packages/infrastructure/src/model/registry.ts';

const RUN_SCOPE = 'run-embedding-deadline';
const REMAINING_DEADLINE_MS = 40;
const HANG_BUDGET_MS = 750;

const BUDGET: RunBudgetLimits = {
  scope: RUN_SCOPE,
  maxCalls: 4,
  deadlineMs: REMAINING_DEADLINE_MS
};

type LedgerCalls = { settled: number; released: number };

/** Stands in for the durable ledger so the deadline is decided by the test, not by Postgres. */
function fakeLedger(calls: LedgerCalls): PostgresProviderAttemptLedger {
  return {
    async assertRunBudget() {},
    async remainingDeadlineMs() {
      return REMAINING_DEADLINE_MS;
    },
    async beginAttempt() {
      return {
        reservationId: 'reservation',
        attemptId: 'attempt',
        ordinal: 1,
        grantedOutputTokens: 1
      };
    },
    async settleAttempt() {
      calls.settled += 1;
    },
    async releaseAttempt() {
      calls.released += 1;
    }
  } as unknown as PostgresProviderAttemptLedger;
}

/** An embedding provider that only ever answers by being aborted. */
const hangingGateway: EmbeddingGateway = {
  async embed(_values, options) {
    return new Promise<number[][]>((_resolve, reject) => {
      const signal = options?.signal;
      if (signal === undefined) return;
      if (signal.aborted) {
        reject(signal.reason as Error);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason as Error));
    });
  }
};

/** A fetch that never answers unless the request is aborted, so no network is ever touched. */
function hangingFetch(): Readonly<{ fetch: typeof globalThis.fetch; calls: string[] }> {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push(input.toString());
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? undefined;
        if (signal === undefined) return;
        if (signal.aborted) {
          reject(signal.reason as Error);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason as Error));
      });
    }
  };
}

/** Resolves to the call's outcome, or to the sentinel when the call is still holding the worker. */
async function settleOrHang(call: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    call.then(
      () => 'resolved',
      (error: unknown) => error
    ),
    new Promise((resolve) => setTimeout(() => resolve('still-in-flight'), HANG_BUDGET_MS))
  ]);
}

describe('run-scoped embedding deadline', () => {
  it('aborts an in-flight embedding at the run deadline and releases the attempt', async () => {
    const calls: LedgerCalls = { settled: 0, released: 0 };
    const scoped = await runScopedEmbedding(
      hangingGateway,
      fakeLedger(calls),
      'openrouter',
      'openai/text-embedding-3-small'
    )({ runScope: RUN_SCOPE, budget: BUDGET });

    const outcome = await settleOrHang(scoped.embed(['deadline probe']));

    expect(outcome).not.toBe('still-in-flight');
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).name).toBe('TimeoutError');
    expect(calls.released).toBe(1);
    expect(calls.settled).toBe(0);
  });

  it('leaves an embedding that answers within the deadline untouched', async () => {
    const calls: LedgerCalls = { settled: 0, released: 0 };
    const gateway: EmbeddingGateway = {
      async embed(values) {
        return values.map(() => [1, 0]);
      }
    };
    const scoped = await runScopedEmbedding(
      gateway,
      fakeLedger(calls),
      'mock',
      'mock-embedding'
    )({ runScope: RUN_SCOPE, budget: BUDGET });

    expect(await scoped.embed(['prompt'])).toEqual([[1, 0]]);
    expect(calls.settled).toBe(1);
    expect(calls.released).toBe(0);
  });

  it('carries the caller signal into the OpenRouter embedding request', async () => {
    const transport = hangingFetch();
    const gateways = createOpenRouterModelGateways({
      apiKey: 'secret',
      generationModelId: 'openai/gpt-5.6-luna',
      embeddingModelId: 'openai/text-embedding-3-small',
      attemptLedger: fakeLedger({ settled: 0, released: 0 }),
      fetch: transport.fetch
    });

    const outcome = await settleOrHang(
      gateways.embeddingGateway.embed(['probe'], { signal: AbortSignal.timeout(30) })
    );

    expect(transport.calls).toEqual(['https://openrouter.ai/api/v1/embeddings']);
    expect(outcome).not.toBe('still-in-flight');
    expect(outcome).toBeInstanceOf(Error);
  });

  it('carries the caller signal into the Ollama embedding request', async () => {
    const transport = hangingFetch();
    const gateways = createOllamaModelGateways(
      {
        // A closed local port, so an unstubbed fetch cannot reach any network.
        baseURL: 'http://127.0.0.1:1/api',
        apiKey: 'secret',
        generationModelId: 'qwen3',
        embeddingModelId: 'embeddinggemma',
        attemptLedger: fakeLedger({ settled: 0, released: 0 }),
        fetch: transport.fetch
      },
      { nativeStructuredOutput: false }
    );

    const outcome = await settleOrHang(
      gateways.embeddingGateway.embed(['probe'], { signal: AbortSignal.timeout(30) })
    );

    expect(transport.calls).toEqual(['http://127.0.0.1:1/api/embed']);
    expect(outcome).not.toBe('still-in-flight');
    expect(outcome).toBeInstanceOf(Error);
  });
});
