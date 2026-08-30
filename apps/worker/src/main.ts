import 'reflect-metadata';
import type { DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ProcessDealBriefStep } from '@slacato/core';
import {
  BullMqCommandQueue,
  type ConfiguredModelGateways,
  createDatabaseClient,
  createWorkerModelGateways,
  type DatabaseClient,
  DealBriefProcessor,
  type Env,
  loadRuntimeEnv,
  OutboxDispatcher,
  OutboxDispatcherLoop,
  PostgresCommandReconciler,
  PostgresDealBriefContextRepository,
  PostgresDealBriefPolicyFacts,
  PostgresDealBriefWorkflowServices,
  PostgresProviderAttemptLedger,
  PostgresWorkflowStore,
  ReconcilerLoop,
  WORKFLOW_DEAD_LETTER_QUEUE_NAME,
  type WorkerCompositionOverrides
} from '@slacato/infrastructure';
import { WorkerModule } from './worker.module.js';

export interface WorkerApplicationOptions {
  environment?: NodeJS.ProcessEnv;
  modelGateway?: WorkerModelGatewayOptions;
}

export type WorkerModelGatewayOptions = WorkerCompositionOverrides;

/** Creates the model gateways used by the worker for its configured AI provider. */
export class WorkerModelGatewayFactory {
  /** Initializes the factory with validated runtime configuration and the provider-attempt ledger. */
  public constructor(
    private readonly environment: Env,
    private readonly attemptLedger: PostgresProviderAttemptLedger
  ) {}

  /** Builds model gateways for the configured provider and applies any worker-specific overrides. */
  public create(options: WorkerModelGatewayOptions = {}): ConfiguredModelGateways {
    return createWorkerModelGateways(this.environment, this.attemptLedger, options);
  }
}

/** Creates the worker module with a model gateway factory backed by the worker database. */
export function createWorkerCompositionModule(
  environment: Env,
  database: DatabaseClient
): DynamicModule {
  const factory = new WorkerModelGatewayFactory(
    environment,
    new PostgresProviderAttemptLedger(database)
  );
  return {
    module: WorkerModule,
    providers: [{ provide: WorkerModelGatewayFactory, useValue: factory }],
    exports: [WorkerModelGatewayFactory]
  };
}

/** Creates the worker context only after server-only configuration has validated successfully. */
export async function createWorkerApplication(options: WorkerApplicationOptions = {}) {
  const environment = loadRuntimeEnv(options.environment ?? process.env);
  const database = createDatabaseClient(environment.DATABASE_URL, 10);
  const app = await NestFactory.createApplicationContext(
    createWorkerCompositionModule(environment, database)
  );
  const gateways = app.get(WorkerModelGatewayFactory).create(options.modelGateway);
  const workflowStore = new PostgresWorkflowStore(database);
  const contextRepository = new PostgresDealBriefContextRepository(database);
  const workflowServices = new PostgresDealBriefWorkflowServices(
    contextRepository,
    new PostgresDealBriefPolicyFacts(database),
    gateways
  );
  const processor = new DealBriefProcessor(
    new ProcessDealBriefStep(workflowStore, workflowServices, { leaseMs: 120_000 }),
    {
      redisUrl: environment.REDIS_URL,
      workerId: `${process.pid}:${crypto.randomUUID()}`,
      concurrency: 1,
      jobsPerSecond: 2,
      lockDurationMs: 180_000
    }
  );
  const commands = new BullMqCommandQueue(environment.REDIS_URL);
  const deadLetters = new BullMqCommandQueue(
    environment.REDIS_URL,
    WORKFLOW_DEAD_LETTER_QUEUE_NAME
  );
  const dispatcher = new OutboxDispatcher(database, commands, deadLetters);
  const loop = new OutboxDispatcherLoop(dispatcher, 1_000, 25);
  const reconciler = new ReconcilerLoop(
    new PostgresCommandReconciler(database, commands, deadLetters),
    5_000,
    25
  );
  loop.start();
  reconciler.start();
  /** Stops delivery loops and closes their shared resources in dependency order. */
  const close = async () => {
    await reconciler.stop();
    await loop.stop();
    await processor.close();
    await commands.close();
    await deadLetters.close();
    await database.close();
  };
  process.once('SIGTERM', () => {
    void close();
  });
  process.once('SIGINT', () => {
    void close();
  });
  app.enableShutdownHooks();
  return app;
}

/** Starts the worker application with the supplied runtime options. */
export async function bootstrap(options: WorkerApplicationOptions = {}) {
  return createWorkerApplication(options);
}

if (process.env.SLACATO_BOOTSTRAP === '1') void bootstrap();
