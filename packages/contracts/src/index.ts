import { z } from 'zod';

export * from './auth.js';
export * from './events.js';

export const liveHealthSchema = z.object({ status: z.literal('live') }).strict();
export const readyHealthSchema = z.object({
  status: z.literal('ready'),
  checks: z.object({ database: z.literal('ready'), migration: z.literal('ready'), redis: z.literal('ready'), index: z.literal('ready'), model: z.literal('ready') }).strict()
}).strict();
export const notReadyHealthSchema = z.object({
  status: z.literal('not_ready'),
  checks: z.object({
    database: z.enum(['ready', 'unavailable']), migration: z.enum(['ready', 'unavailable']), redis: z.enum(['ready', 'unavailable']), index: z.enum(['ready', 'unavailable']), model: z.enum(['ready', 'unavailable'])
  }).strict(),
  detail: z.object({ code: z.enum(['MODEL_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE']), generation: z.literal('disabled') }).strict()
}).strict();
export const readinessHealthSchema = z.union([readyHealthSchema, notReadyHealthSchema]);


export type LiveHealth = z.infer<typeof liveHealthSchema>;
export type ReadinessHealth = z.infer<typeof readinessHealthSchema>;
