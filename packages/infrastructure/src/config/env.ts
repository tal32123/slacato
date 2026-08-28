import { z } from 'zod';

/** Validates server configuration without reading global process state at import time. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  OLLAMA_API_KEY: z.string().min(1),
  OLLAMA_BASE_URL: z.string().url().default('https://ollama.com/api'),
  OLLAMA_CHAT_MODEL: z.string().min(1),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
}).strict();

export type Env = z.infer<typeof envSchema>;

export const parseEnv = (input: NodeJS.ProcessEnv): Env => envSchema.parse(input);
