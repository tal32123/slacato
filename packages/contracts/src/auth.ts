import { z } from 'zod';

export const personaIdSchema = z.string().regex(/^USR-\d+$/);
export const personaSchema = z.object({
  userId: personaIdSchema,
  displayName: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(120)
}).strict();
export const personaListResponseSchema = z.object({ personas: z.array(personaSchema).max(50) }).strict();

export const anonymousSessionSchema = z.object({ authenticated: z.literal(false) }).strict();
export const authenticatedSessionSchema = z.object({
  authenticated: z.literal(true),
  persona: personaSchema,
  version: z.string().uuid()
}).strict();
export const authSessionResponseSchema = z.discriminatedUnion('authenticated', [anonymousSessionSchema, authenticatedSessionSchema]);

export const csrfResponseSchema = z.object({ csrfToken: z.string().min(32).max(256) }).strict();
export const selectPersonaRequestSchema = z.object({ userId: personaIdSchema }).strict();
export const authenticatedMutationResponseSchema = z.object({
  session: authenticatedSessionSchema,
  csrfToken: csrfResponseSchema.shape.csrfToken
}).strict();
export const logoutResponseSchema = z.object({
  session: anonymousSessionSchema,
  csrfToken: csrfResponseSchema.shape.csrfToken
}).strict();

export const authErrorResponseSchema = z.object({
  code: z.enum(['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_CSRF']),
  message: z.string().min(1).max(160)
}).strict();

export type Persona = z.infer<typeof personaSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type SelectPersonaRequest = z.infer<typeof selectPersonaRequestSchema>;
