import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { json } from 'express';
import { NestFactory } from '@nestjs/core';
import type { ErrorRequestHandler } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadRuntimeEnv } from '@slacato/infrastructure';
import { AppModule } from './app.module.js';

export interface ApiApplicationOptions {
  environment?: NodeJS.ProcessEnv;
}

const bodyParserErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  const parserError = error as { type?: string };
  if (parserError.type === 'entity.too.large') {
    response.status(413).json({ code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the 1 MiB limit' });
    return;
  }
  if (parserError.type === 'entity.parse.failed') {
    response.status(400).json({ code: 'INVALID_JSON', message: 'Malformed JSON request body' });
    return;
  }
  next(error);
};

/** Installs the runtime wire boundary for all Nest HTTP applications. */
export function configureApiApplication(app: NestExpressApplication): void {
  app.use(json({ limit: '1mb', type: 'application/json' }));
  app.use(bodyParserErrorHandler);
  app.enableShutdownHooks();
}

/** Creates the API only after server-only configuration has validated successfully. */
export async function createApiApplication(options: ApiApplicationOptions = {}): Promise<NestExpressApplication> {
  loadRuntimeEnv(options.environment ?? process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
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
