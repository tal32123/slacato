import 'reflect-metadata';
import { json } from 'express';
import { HttpException, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { ErrorRequestHandler } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CancelDealBrief, DecideApproval, RegenerateDealBrief, StartDealBrief } from '@slacato/core';
import {
  createDatabaseClient,
  loadRuntimeEnv,
  PostgresApprovalAuthorityQuery,
  PostgresCanonicalPersonaDirectory,
  PostgresDealBriefAccessControl,
  PostgresEventStore,
  PostgresRunEventQuery,
  PostgresWorkflowStore,
  type Env
} from '@slacato/infrastructure';
import { PostgresSessionRegistry } from './modules/auth/postgres-session-registry.js';
import { AppModule } from './app.module.js';
import { PostgresDealQueryRepository } from './modules/deals/deals.repository.js';
import { PostgresRunApprovalQueryRepository } from './modules/runs/run-approval.repository.js';
import { PostgresBriefExportService } from './modules/exports/exports.service.js';
import { ApiWireBoundaryMiddleware } from './common/wire/api-wire-boundary.middleware.js';
import { WireContractInterceptor } from './common/wire/wire-contract.interceptor.js';
import type { ProviderRuntimeDescriptor } from './modules/diagnostics/contracts.js';

export interface ApiApplicationOptions {
  environment?: NodeJS.ProcessEnv;
}

/** Resolves the configured model names at the provider-selection composition boundary. */
export function configuredProviderModels(environment: Env): Readonly<{ generation: string; embedding: string }> {
  if (environment.AI_PROVIDER === 'ollama') {
    return { generation: environment.OLLAMA_CHAT_MODEL, embedding: environment.OLLAMA_EMBEDDING_MODEL };
  }
  if (environment.AI_PROVIDER === 'openrouter') {
    return { generation: environment.OPENROUTER_CHAT_MODEL, embedding: environment.OPENROUTER_EMBEDDING_MODEL };
  }
  return { generation: 'mock-brief', embedding: 'mock-embedding' };
}

/** Describes the provider runtime facts that diagnostics reports without reconstructing them. */
export function configuredProviderRuntime(environment: Env): ProviderRuntimeDescriptor {
  const models = configuredProviderModels(environment);
  if (environment.AI_PROVIDER === 'mock') {
    return {
      provider: environment.AI_PROVIDER,
      outputMode: 'deterministic_mock',
      pinnedGenerationModel: models.generation,
      pinnedEmbeddingModel: models.embedding
    };
  }
  if (environment.AI_PROVIDER === 'openrouter') {
    return {
      provider: environment.AI_PROVIDER,
      outputMode: 'native_schema',
      pinnedGenerationModel: models.generation,
      pinnedEmbeddingModel: models.embedding
    };
  }
  return {
    provider: environment.AI_PROVIDER,
    outputMode: 'capability_probe_required',
    pinnedGenerationModel: models.generation,
    pinnedEmbeddingModel: models.embedding
  };
}

const bodyParserErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  void next;
  if (error instanceof HttpException) {
    response.status(error.getStatus()).json(error.getResponse());
    return;
  }
  const parserError = error as { type?: string };
  if (parserError.type === 'entity.too.large') {
    response.status(413).json({ code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the 1 MiB limit' });
    return;
  }
  if (parserError.type === 'entity.parse.failed') {
    response.status(400).json({ code: 'INVALID_JSON', message: 'Malformed JSON request body' });
    return;
  }
  response.status(400).json({ code: 'INVALID_REQUEST', message: 'Request body could not be processed' });
};

/** Installs the runtime wire boundary for all Nest HTTP applications. */
export function configureApiApplication(app: NestExpressApplication): void {
  const wireMiddleware = new ApiWireBoundaryMiddleware();
  app.use(json({ limit: '1mb', type: 'application/json' }));
  app.use(wireMiddleware.use.bind(wireMiddleware));
  app.use(bodyParserErrorHandler);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalInterceptors(new WireContractInterceptor(app.get(Reflector)));
  app.enableShutdownHooks();
}

/** Creates the API only after server-only configuration has validated successfully. */
export async function createApiApplication(options: ApiApplicationOptions = {}): Promise<NestExpressApplication> {
  const env = loadRuntimeEnv(options.environment ?? process.env);
  const providerRuntime = configuredProviderRuntime(env);
  const database = createDatabaseClient(env.DATABASE_URL, 5);
  const personas = new PostgresCanonicalPersonaDirectory(database);
  const workflowStore = new PostgresWorkflowStore(database);
  const workflowAccess = new PostgresDealBriefAccessControl(database);
  const runEvents = new PostgresEventStore(database);
  const dealQueries = new PostgresDealQueryRepository(database);
  const runApprovalQueries = new PostgresRunApprovalQueryRepository(database);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register({
    sessionSecret: env.SESSION_SECRET,
    environment: env.NODE_ENV,
    allowedOrigins: [env.WEB_ORIGIN],
    personaDirectory: personas,
    sessionRegistry: new PostgresSessionRegistry(database)
  }, {
    startDealBrief: new StartDealBrief(workflowStore, workflowAccess, {
      provider: env.AI_PROVIDER,
      model: providerRuntime.pinnedGenerationModel
    }),
    regenerateDealBrief: new RegenerateDealBrief(workflowStore, workflowAccess),
    cancelDealBrief: new CancelDealBrief(workflowStore, workflowAccess),
    decideApproval: new DecideApproval(workflowStore, workflowAccess),
    queries: runApprovalQueries,
    runEvents: { bus: runEvents, query: new PostgresRunEventQuery(database) }
  }, {
    providerRuntime,
    approvalAuthorities: new PostgresApprovalAuthorityQuery(database)
  }, {
    repository: dealQueries
  }, new PostgresBriefExportService(database)), { bodyParser: false });
  configureApiApplication(app);
  return app;
}

export async function bootstrap(options: ApiApplicationOptions = {}): Promise<NestExpressApplication> {
  const app = await createApiApplication(options);
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
  return app;
}

if (process.env.SLACATO_BOOTSTRAP === '1') void bootstrap();
