import { z } from 'zod';

const exactOrigin = z
  .url()
  .refine((value) => new URL(value).origin === value, 'Must be an exact URL origin without a path');

const commonEnvironment = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:56379'),
  WEB_ORIGIN: exactOrigin.default('http://127.0.0.1:4173'),
  SESSION_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Absent means "no sandbox reset in this build". Only the exact literal `enabled` turns the
  // capability on (see config/sandbox.ts), so a typo, an empty string, or a truthy-looking `1`
  // leaves it off. The value is parsed as a free string rather than a literal on purpose: a
  // mistyped opt-in should cost a missing button, not refuse to boot a running deployment.
  SLACATO_SANDBOX_RESET: z.string().optional(),
  SLACATO_SANDBOX_RESET_DATABASE: z.string().min(1).optional()
};

const mockEnvironment = z
  .object({
    ...commonEnvironment,
    AI_PROVIDER: z.literal('mock'),
    OLLAMA_API_KEY: z.string().min(1).optional(),
    OLLAMA_BASE_URL: z.string().url().optional(),
    OLLAMA_CHAT_MODEL: z.string().min(1).optional(),
    OLLAMA_EMBEDDING_MODEL: z.string().min(1).optional(),
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    OPENROUTER_CHAT_MODEL: z.string().min(1).optional(),
    OPENROUTER_EMBEDDING_MODEL: z.string().min(1).optional()
  })
  .strict();

const ollamaEnvironment = z
  .object({
    ...commonEnvironment,
    AI_PROVIDER: z.literal('ollama'),
    OLLAMA_API_KEY: z.string().min(1),
    OLLAMA_BASE_URL: z.string().url().default('https://ollama.com/api'),
    OLLAMA_CHAT_MODEL: z.string().min(1),
    OLLAMA_EMBEDDING_MODEL: z.string().min(1)
  })
  .strict();

const openRouterEnvironment = z
  .object({
    ...commonEnvironment,
    AI_PROVIDER: z.literal('openrouter'),
    OPENROUTER_API_KEY: z.string().min(1),
    OPENROUTER_CHAT_MODEL: z.string().min(1).default('openai/gpt-5.6-luna'),
    OPENROUTER_EMBEDDING_MODEL: z.string().min(1).default('openai/text-embedding-3-small')
  })
  .strict();

/** Discriminated provider configuration; mock is the initial-release default. */
export const envSchema = z.preprocess(
  (input) => {
    if (
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input) ||
      'AI_PROVIDER' in input
    )
      return input;
    return { ...input, AI_PROVIDER: 'mock' };
  },
  z.discriminatedUnion('AI_PROVIDER', [mockEnvironment, ollamaEnvironment, openRouterEnvironment])
);

export type Env = z.infer<typeof envSchema>;

const envKeys = [
  'NODE_ENV',
  'DATABASE_URL',
  'REDIS_URL',
  'WEB_ORIGIN',
  'SESSION_SECRET',
  'LOG_LEVEL',
  'SLACATO_SANDBOX_RESET',
  'SLACATO_SANDBOX_RESET_DATABASE',
  'AI_PROVIDER',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_CHAT_MODEL',
  'OLLAMA_EMBEDDING_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_CHAT_MODEL',
  'OPENROUTER_EMBEDDING_MODEL'
] as const;

/** Parses process variables into validated provider-specific runtime configuration. */
export const parseEnv = (input: NodeJS.ProcessEnv): Env =>
  envSchema.parse(
    Object.fromEntries(
      envKeys.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]]))
    )
  );
