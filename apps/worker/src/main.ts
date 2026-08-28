import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { BullMqCommandQueue, createConfiguredModelGateways, createDatabaseClient, loadRuntimeEnv, OutboxDispatcher, OutboxDispatcherLoop, PostgresCommandReconciler, ReconcilerLoop, WORKFLOW_DEAD_LETTER_QUEUE_NAME, type ConfiguredModelGateways, type DatabaseClient, type Env, type MockGenerationResolver, type OllamaCapabilities } from '@slacato/infrastructure';
import type { Provider } from '@nestjs/common';
import { WorkerModule } from './worker.module.js';

export interface WorkerApplicationOptions {
  environment?: NodeJS.ProcessEnv;
}

export const WORKER_MODEL_GATEWAYS = Symbol('WORKER_MODEL_GATEWAYS');
export type WorkerModelGatewayOptions = Readonly<{ mockFixtureResolver?: MockGenerationResolver; ollamaCapabilities?: Pick<OllamaCapabilities, 'nativeStructuredOutput'> }>;

/** Generic composition hook for Task 9; bootstrap never invents a mock resolver. */
export function createWorkerModelGateways(environment: Env, database: DatabaseClient, options: WorkerModelGatewayOptions = {}): ConfiguredModelGateways {
  if (environment.AI_PROVIDER === 'mock') {
    if (options.mockFixtureResolver === undefined) throw new Error('Worker mock model composition requires a fixture resolver');
    return createConfiguredModelGateways(environment, { database, mock: { resolve: options.mockFixtureResolver } });
  }
  return createConfiguredModelGateways(environment, { database, ...(options.ollamaCapabilities === undefined ? {} : { ollamaCapabilities: options.ollamaCapabilities }) });
}

/** Nest provider factory intentionally remains unregistered until Task 9 supplies its processor. */
export function createWorkerModelGatewayProvider(environment: Env, database: DatabaseClient, options: WorkerModelGatewayOptions = {}): Provider {
  return { provide: WORKER_MODEL_GATEWAYS, useFactory: () => createWorkerModelGateways(environment, database, options) };
}

/** Creates the worker context only after server-only configuration has validated successfully. */
export async function createWorkerApplication(options: WorkerApplicationOptions = {}) {
  const environment = loadRuntimeEnv(options.environment ?? process.env);
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const database = createDatabaseClient(environment.DATABASE_URL, 10);
  const commands = new BullMqCommandQueue(environment.REDIS_URL);
  const deadLetters = new BullMqCommandQueue(environment.REDIS_URL, WORKFLOW_DEAD_LETTER_QUEUE_NAME);
  const dispatcher = new OutboxDispatcher(database, commands, deadLetters);
  const loop = new OutboxDispatcherLoop(dispatcher, 1_000, 25);
  const reconciler = new ReconcilerLoop(new PostgresCommandReconciler(database, commands, deadLetters), 5_000, 25);
  loop.start();
  reconciler.start();
  const close = async () => { await reconciler.stop(); await loop.stop(); await commands.close(); await deadLetters.close(); await database.close(); };
  process.once('SIGTERM', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  app.enableShutdownHooks();
  return app;
}

export async function bootstrap(options: WorkerApplicationOptions = {}) {
  return createWorkerApplication(options);
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) void bootstrap();
