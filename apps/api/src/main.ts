import 'reflect-metadata';
import { HttpException, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  CancelDealBrief,
  DecideApproval,
  type ReadinessDependencies,
  RegenerateDealBrief,
  StartDealBrief
} from '@slacato/core';
import {
  BullMqCommandQueue,
  createDatabaseClient,
  createProductionReadinessChecks,
  type Env,
  loadRuntimeEnv,
  PostgresApprovalAuthorityQuery,
  PostgresApprovalQueryRepository,
  PostgresBriefExportService,
  PostgresCanonicalPersonaDirectory,
  PostgresDealBriefAccessControl,
  PostgresDealQueryRepository,
  PostgresEventStore,
  PostgresRunEventQuery,
  PostgresRunQueryRepository,
  PostgresSessionRegistry,
  PostgresWorkflowStore,
  resolveConfiguredProvider,
  resolveProviderModels,
  resolveProviderRuntimeFacts
} from '@slacato/infrastructure';
import type { ErrorRequestHandler } from 'express';
import { json } from 'express';
import { AppModule } from './app.module.js';
import { ApiWireBoundaryMiddleware } from './common/wire/api-wire-boundary.middleware.js';
import { WireContractInterceptor } from './common/wire/wire-contract.interceptor.js';
import type { ProviderRuntimeDescriptor } from './modules/diagnostics/contracts.js';

export interface ApiApplicationOptions {
  environment?: NodeJS.ProcessEnv;
  readiness?: ReadinessDependencies;
}

/** Resolves the configured model names at the provider-selection composition boundary. */
export function configuredProviderModels(
  environment: Env
): Readonly<{ generation: string; embedding: string }> {
  return resolveProviderModels(environment);
}

/** Describes the provider runtime facts that diagnostics reports without reconstructing them. */
export function configuredProviderRuntime(environment: Env): ProviderRuntimeDescriptor {
  return resolveProviderRuntimeFacts(environment);
}

/** Converts body-parser failures into the API's stable HTTP error responses. */
const bodyParserErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  void next;
  if (error instanceof HttpException) {
    response.status(error.getStatus()).json(error.getResponse());
    return;
  }
  const parserError = error as { type?: string };
  if (parserError.type === 'entity.too.large') {
    response
      .status(413)
      .json({ code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the 1 MiB limit' });
    return;
  }
  if (parserError.type === 'entity.parse.failed') {
    response.status(400).json({ code: 'INVALID_JSON', message: 'Malformed JSON request body' });
    return;
  }
  response
    .status(400)
    .json({ code: 'INVALID_REQUEST', message: 'Request body could not be processed' });
};

/** Installs the runtime wire boundary for all Nest HTTP applications. */
export function configureApiApplication(app: NestExpressApplication): void {
  const wireMiddleware = new ApiWireBoundaryMiddleware();
  app.use(json({ limit: '1mb', type: 'application/json' }));
  app.use(wireMiddleware.use.bind(wireMiddleware));
  app.use(bodyParserErrorHandler);
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
  );
  app.useGlobalInterceptors(new WireContractInterceptor(app.get(Reflector)));
  app.enableShutdownHooks();
}

/** Creates the API only after server-only configuration has validated successfully. */
export async function createApiApplication(
  options: ApiApplicationOptions = {}
): Promise<NestExpressApplication> {
  const env = loadRuntimeEnv(options.environment ?? process.env);
  const providerRuntime = configuredProviderRuntime(env);
  const database = createDatabaseClient(env.DATABASE_URL, 5);
  const provider = resolveConfiguredProvider(env);
  let redis: BullMqCommandQueue | undefined;
  let readiness: ReadinessDependencies;
  if (options.readiness === undefined) {
    redis = new BullMqCommandQueue(env.REDIS_URL);
    readiness = createProductionReadinessChecks({ database, redis, provider });
  } else {
    readiness = options.readiness;
  }
  const personas = new PostgresCanonicalPersonaDirectory(database);
  const workflowStore = new PostgresWorkflowStore(database);
  const workflowAccess = new PostgresDealBriefAccessControl(database);
  const runEvents = new PostgresEventStore(database);
  const dealQueries = new PostgresDealQueryRepository(database);
  const runQueries = new PostgresRunQueryRepository(database);
  const approvalQueries = new PostgresApprovalQueryRepository(database);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(
      {
        sessionSecret: env.SESSION_SECRET,
        environment: env.NODE_ENV,
        allowedOrigins: [env.WEB_ORIGIN],
        personaDirectory: personas,
        sessionRegistry: new PostgresSessionRegistry(database)
      },
      {
        startDealBrief: new StartDealBrief(workflowStore, workflowAccess, {
          provider: env.AI_PROVIDER,
          model: providerRuntime.pinnedGenerationModel
        }),
        regenerateDealBrief: new RegenerateDealBrief(workflowStore, workflowAccess),
        cancelDealBrief: new CancelDealBrief(workflowStore, workflowAccess),
        decideApproval: new DecideApproval(workflowStore, workflowAccess),
        runQueries,
        approvalQueries,
        runEvents: { bus: runEvents, query: new PostgresRunEventQuery(database) }
      },
      {
        providerRuntime,
        approvalAuthorities: new PostgresApprovalAuthorityQuery(database)
      },
      {
        repository: dealQueries,
        denials: workflowAccess
      },
      new PostgresBriefExportService(database),
      {
        readiness,
        ...(redis === undefined ? {} : { close: () => redis.close() })
      }
    ),
    { bodyParser: false }
  );
  configureApiApplication(app);
  return app;
}

/** Creates and starts the configured API server on the selected port. */
export async function bootstrap(
  options: ApiApplicationOptions = {}
): Promise<NestExpressApplication> {
  const app = await createApiApplication(options);
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
  return app;
}

if (process.env.SLACATO_BOOTSTRAP === '1') void bootstrap();
