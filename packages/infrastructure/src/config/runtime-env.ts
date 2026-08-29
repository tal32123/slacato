import { type Env, parseEnv } from './env.js';

/** Server composition roots opt into process environment parsing explicitly. */
export const loadRuntimeEnv = (input: NodeJS.ProcessEnv = process.env): Env => parseEnv(input);
