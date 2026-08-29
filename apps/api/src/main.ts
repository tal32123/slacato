import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { json } from 'express';
import { HttpException, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { ErrorRequestHandler } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DecideApproval, StartDealBrief } from '@slacato/core';
import { createDatabaseClient, loadRuntimeEnv, PostgresCanonicalPersonaDirectory, PostgresDealBriefAccessControl, PostgresWorkflowStore } from '@slacato/infrastructure';
import { AppModule } from './app.module.js';
import { ApiWireBoundaryMiddleware } from './common/wire/api-wire-boundary.middleware.js';
import { WireContractInterceptor } from './common/wire/wire-contract.interceptor.js';

export interface ApiApplicationOptions {
  environment?: NodeJS.ProcessEnv;
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
  const database = createDatabaseClient(env.DATABASE_URL, 5);
  const personas = new PostgresCanonicalPersonaDirectory(database);
  const workflowStore = new PostgresWorkflowStore(database);
  const workflowAccess = new PostgresDealBriefAccessControl(database);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register({
    sessionSecret: env.SESSION_SECRET,
    environment: env.NODE_ENV,
    allowedOrigins: [env.WEB_ORIGIN],
    personaDirectory: personas
  }, {
    startDealBrief: new StartDealBrief(workflowStore, workflowAccess),
    decideApproval: new DecideApproval(workflowStore, workflowAccess)
  }), { bodyParser: false });
  configureApiApplication(app);
  return app;
}

export async function bootstrap(options: ApiApplicationOptions = {}): Promise<NestExpressApplication> {
  const app = await createApiApplication(options);
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
  return app;
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) void bootstrap();
