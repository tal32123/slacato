import { z } from 'zod';

export * from './approvals.js';
export * from './auth.js';
export * from './deals.js';
export * from './diagnostics.js';
export * from './events.js';
export * from './runs.js';

export const liveHealthSchema = z.object({ status: z.literal('live') }).strict();
export const readyHealthSchema = z
  .object({
    status: z.literal('ready'),
    checks: z
      .object({
        database: z.literal('ready'),
        migration: z.literal('ready'),
        redis: z.literal('ready'),
        index: z.literal('ready'),
        model: z.literal('ready')
      })
      .strict()
  })
  .strict();
export const notReadyHealthSchema = z
  .object({
    status: z.literal('not_ready'),
    checks: z
      .object({
        database: z.enum(['ready', 'unavailable', 'unconfigured']),
        migration: z.enum(['ready', 'unavailable', 'unconfigured']),
        redis: z.enum(['ready', 'unavailable', 'unconfigured']),
        index: z.enum(['ready', 'unavailable', 'unconfigured']),
        model: z.enum(['ready', 'unavailable', 'unconfigured'])
      })
      .strict(),
    detail: z
      .object({
        code: z.enum(['MODEL_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE']),
        generation: z.literal('disabled')
      })
      .strict()
  })
  .strict();
export const unconfiguredHealthSchema = z
  .object({
    status: z.literal('unconfigured'),
    checks: z
      .object({
        database: z.enum(['ready', 'unconfigured']),
        migration: z.enum(['ready', 'unconfigured']),
        redis: z.enum(['ready', 'unconfigured']),
        index: z.enum(['ready', 'unconfigured']),
        model: z.enum(['ready', 'unconfigured'])
      })
      .strict(),
    detail: z
      .object({ code: z.literal('CHECKS_UNCONFIGURED'), generation: z.literal('disabled') })
      .strict()
  })
  .strict();
export const readinessHealthSchema = z.union([
  readyHealthSchema,
  notReadyHealthSchema,
  unconfiguredHealthSchema
]);

export type LiveHealth = z.infer<typeof liveHealthSchema>;
export type ReadinessHealth = z.infer<typeof readinessHealthSchema>;
