import { Writable } from 'node:stream';
import type { CommandQueue, WorkflowCommand } from '@slacato/core';
import type { DatabaseClient } from '@slacato/infrastructure/db/client';
import { createSafeLogger } from '@slacato/infrastructure/logging/logger';
import {
  OutboxDispatcher,
  OutboxDispatcherLoop
} from '@slacato/infrastructure/queue/outbox-dispatcher';
import { type PostgresCommandReconciler, ReconcilerLoop } from '@slacato/infrastructure/queue/reconciler';
import { afterEach, describe, expect, it } from 'vitest';

type LogRecord = Readonly<Record<string, unknown>>;

/** Collects the structured records a loop emits, exactly as they would reach the log destination. */
function captureLogger() {
  const records: LogRecord[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      records.push(JSON.parse(String(chunk)) as LogRecord);
      callback();
    }
  });
  return { records, telemetry: createSafeLogger(destination) };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A dispatcher whose every batch fails, standing in for a permanently unreachable dependency. */
const brokenDispatcher = (): OutboxDispatcher =>
  ({
    dispatchBatch: async () => {
      throw new TypeError('database unavailable');
    }
  }) as unknown as OutboxDispatcher;

/** A reconciler whose every pass fails, standing in for a permanently unreachable dependency. */
const brokenReconciler = (): PostgresCommandReconciler =>
  ({
    reconcile: async () => {
      throw new TypeError('database unavailable');
    }
  }) as unknown as PostgresCommandReconciler;

/** A database that returns one claimable outbox row and accepts every subsequent statement. */
function stubDatabase(rows: readonly unknown[]): DatabaseClient {
  const sql = Object.assign(async () => Object.assign([], { count: 1 }), {
    begin: async (work: (inner: unknown) => Promise<unknown>) => work(async () => rows)
  });
  return { sql, db: {}, close: async () => {} } as unknown as DatabaseClient;
}

let running: { stop: () => Promise<void> } | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe('delivery loop failures are never silent', () => {
  it('reports every discarded outbox dispatch pass with its consecutive failure count', async () => {
    const { records, telemetry } = captureLogger();
    const loop = new OutboxDispatcherLoop(brokenDispatcher(), 5, 1, telemetry);
    running = loop;
    loop.start();
    await pause(60);
    await loop.stop();
    running = undefined;

    const failures = records.filter((record) => record.event === 'outbox_dispatcher_loop_failed');
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures[0]).toMatchObject({
      level: 50,
      status: 'failed',
      errorName: 'TypeError',
      errorCode: 'OUTBOX_DISPATCH_LOOP_FAILED',
      retryCount: 0
    });
    expect(failures[1]?.retryCount).toBe(1);
  });

  it('reports every discarded reconciliation pass with its consecutive failure count', async () => {
    const { records, telemetry } = captureLogger();
    const loop = new ReconcilerLoop(brokenReconciler(), 5, 1, telemetry);
    running = loop;
    loop.start();
    await pause(60);
    await loop.stop();
    running = undefined;

    const failures = records.filter((record) => record.event === 'command_reconciler_loop_failed');
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures[0]).toMatchObject({
      level: 50,
      status: 'failed',
      errorName: 'TypeError',
      errorCode: 'COMMAND_RECONCILE_LOOP_FAILED',
      retryCount: 0
    });
    expect(failures[1]?.retryCount).toBe(1);
  });

  it('reports a command it dead letters after exhausting its delivery attempts', async () => {
    const { records, telemetry } = captureLogger();
    const database = stubDatabase([
      {
        id: 'command_exhausted',
        run_id: 'run_exhausted',
        type: 'process',
        payload: { step: 'start' },
        idempotency_key: 'command_exhausted',
        delivery_attempts: 3,
        claim_token: 'outbox_claim_1'
      }
    ]);
    const rejecting = {
      publish: async () => {
        throw new TypeError('redis unreachable');
      },
      inspect: async () => ({ state: 'missing', attemptsMade: 3, maxAttempts: 3, exhausted: true })
    } as unknown as CommandQueue;
    const deadLetters = {
      publish: async (_command: WorkflowCommand) => {}
    } as unknown as CommandQueue;

    const outcome = await new OutboxDispatcher(
      database,
      rejecting,
      deadLetters,
      3,
      30_000,
      telemetry
    ).dispatchBatch(1);

    expect(outcome.deadLettered).toBe(1);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 50,
        event: 'outbox_command_dead_lettered',
        correlationId: 'command_exhausted',
        runId: 'run_exhausted',
        status: 'dead_letter',
        retryCount: 2,
        errorName: 'TypeError',
        errorCode: 'OUTBOX_COMMAND_PUBLISH_FAILED'
      })
    );
  });
});
