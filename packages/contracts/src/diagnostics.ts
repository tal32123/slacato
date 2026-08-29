import { z } from 'zod';
import { approvalAuthoritySchema } from './approvals.js';
import { authenticatedSessionSchema } from './auth.js';

const readinessStateSchema = z.enum(['ready', 'unavailable', 'unconfigured']);

/** Serializable, secret-free view of the signed browser session. */
export const demoSessionSchema = authenticatedSessionSchema;

/** One canonical source grant projected for diagnostics without approval authority. */
export const permissionGrantViewSchema = z
  .object({
    accountId: z.string().regex(/^ACC-\d+$/),
    sourceType: z.string().trim().min(1).max(80),
    canRead: z.boolean(),
    restrictedOpportunityAccess: z.boolean(),
    sensitivePricing: z.boolean(),
    canRequestApproval: z.boolean()
  })
  .strict();

/** Canonical approval authorities held by one persona for one account. */
export const accountApprovalAuthorityViewSchema = z
  .object({
    accountId: z.string().regex(/^ACC-\d+$/),
    authorities: z.array(approvalAuthoritySchema).max(4)
  })
  .strict();

export const providerHealthViewSchema = z
  .object({
    provider: z.enum(['mock', 'ollama', 'openrouter']),
    outputMode: z.enum(['deterministic_mock', 'capability_probe_required', 'native_schema']),
    pinnedGenerationModel: z.string().trim().min(1).max(200),
    pinnedEmbeddingModel: z.string().trim().min(1).max(200),
    indexHealth: readinessStateSchema,
    runtimeReadiness: z.enum(['ready', 'not_ready', 'unconfigured']),
    checks: z
      .object({
        database: readinessStateSchema,
        migration: readinessStateSchema,
        redis: readinessStateSchema,
        index: readinessStateSchema,
        model: readinessStateSchema
      })
      .strict()
  })
  .strict();

export const demoDiagnosticsResponseSchema = z
  .object({
    sessionVersion: z.string().uuid(),
    permissions: z.array(permissionGrantViewSchema).max(500),
    approvalAuthorities: z.array(accountApprovalAuthorityViewSchema).max(500),
    providerHealth: providerHealthViewSchema
  })
  .strict();

export type DemoSession = z.infer<typeof demoSessionSchema>;
export type PermissionGrantView = z.infer<typeof permissionGrantViewSchema>;
export type AccountApprovalAuthorityView = z.infer<typeof accountApprovalAuthorityViewSchema>;
export type ProviderHealthView = z.infer<typeof providerHealthViewSchema>;
export type DemoDiagnosticsResponse = z.infer<typeof demoDiagnosticsResponseSchema>;
