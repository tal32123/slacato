import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { BullMqCommandQueue, createDatabaseClient, loadRuntimeEnv, OutboxDispatcher, OutboxDispatcherLoop, PostgresCommandReconciler, ReconcilerLoop } from '@slacato/infrastructure';
import { WorkerModule } from './worker.module.js';

export interface WorkerApplicationOptions {
  environment?: NodeJS.ProcessEnv;
}

/** Creates the worker context only after server-only configuration has validated successfully. */
export async function createWorkerApplication(options: WorkerApplicationOptions = {}) {
  const environment = loadRuntimeEnv(options.environment ?? process.env);
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const database = createDatabaseClient(environment.DATABASE_URL, 10);
  const commands = new BullMqCommandQueue(environment.REDIS_URL);
  const deadLetters = new BullMqCommandQueue(environment.REDIS_URL, 'slacato-workflow-dead-letter');
  const dispatcher = new OutboxDispatcher(database, commands, deadLetters);
  const loop = new OutboxDispatcherLoop(dispatcher, 1_000, 25);
  const reconciler = new ReconcilerLoop(new PostgresCommandReconciler(database, commands), 5_000, 25);
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
