import { z } from 'zod';

const commonEnvironment = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
};

const mockEnvironment = z.object({
  ...commonEnvironment,
  AI_PROVIDER: z.literal('mock'),
  OLLAMA_API_KEY: z.string().min(1).optional(),
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_CHAT_MODEL: z.string().min(1).optional(),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).optional()
}).strict();

const ollamaEnvironment = z.object({
  ...commonEnvironment,
  AI_PROVIDER: z.literal('ollama'),
  OLLAMA_API_KEY: z.string().min(1),
  OLLAMA_BASE_URL: z.string().url().default('https://ollama.com/api'),
  OLLAMA_CHAT_MODEL: z.string().min(1),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1)
}).strict();

/** Discriminated provider configuration; mock is the initial-release default. */
export const envSchema = z.preprocess((input) => {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || 'AI_PROVIDER' in input) return input;
  return { ...input, AI_PROVIDER: 'mock' };
}, z.discriminatedUnion('AI_PROVIDER', [mockEnvironment, ollamaEnvironment]));

export type Env = z.infer<typeof envSchema>;

export const parseEnv = (input: NodeJS.ProcessEnv): Env => envSchema.parse(input);
