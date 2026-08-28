import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { BullMqCommandQueue, createConfiguredModelGateways, createDatabaseClient, loadRuntimeEnv, OutboxDispatcher, OutboxDispatcherLoop, PostgresCommandReconciler, PostgresProviderAttemptLedger, ReconcilerLoop, WORKFLOW_DEAD_LETTER_QUEUE_NAME, type ConfiguredModelGateways, type DatabaseClient, type Env, type MockGenerationResolver, type OllamaCapabilities } from '@slacato/infrastructure';
import type { DynamicModule } from '@nestjs/common';
import { WorkerModule } from './worker.module.js';

export interface WorkerApplicationOptions {
  environment?: NodeJS.ProcessEnv;
}

export type WorkerModelGatewayOptions = Readonly<{ mockFixtureResolver?: MockGenerationResolver; ollamaCapabilities?: Pick<OllamaCapabilities, 'nativeStructuredOutput'> }>;

/** Injectable Task 9 seam; mock generation remains impossible without a fixture resolver. */
export class WorkerModelGatewayFactory {
  public constructor(private readonly environment: Env, private readonly attemptLedger: PostgresProviderAttemptLedger) {}

  public create(options: WorkerModelGatewayOptions = {}): ConfiguredModelGateways {
    if (this.environment.AI_PROVIDER === 'mock') {
      if (options.mockFixtureResolver === undefined) throw new Error('Worker mock model composition requires a fixture resolver');
      return createConfiguredModelGateways(this.environment, { attemptLedger: this.attemptLedger, mock: { resolve: options.mockFixtureResolver } });
    }
    return createConfiguredModelGateways(this.environment, { attemptLedger: this.attemptLedger, ...(options.ollamaCapabilities === undefined ? {} : { ollamaCapabilities: options.ollamaCapabilities }) });
  }
}

/** The same module used by bootstrap and composition tests; its ledger shares the worker database lifecycle. */
export function createWorkerCompositionModule(environment: Env, database: DatabaseClient): DynamicModule {
  const factory = new WorkerModelGatewayFactory(environment, new PostgresProviderAttemptLedger(database));
  return { module: WorkerModule, providers: [{ provide: WorkerModelGatewayFactory, useValue: factory }], exports: [WorkerModelGatewayFactory] };
}

/** Creates the worker context only after server-only configuration has validated successfully. */
export async function createWorkerApplication(options: WorkerApplicationOptions = {}) {
  const environment = loadRuntimeEnv(options.environment ?? process.env);
  const database = createDatabaseClient(environment.DATABASE_URL, 10);
  const app = await NestFactory.createApplicationContext(createWorkerCompositionModule(environment, database));
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
