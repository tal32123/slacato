import {
  authErrorResponseSchema,
  authSessionResponseSchema,
  authenticatedMutationResponseSchema,
  csrfResponseSchema,
  demoDiagnosticsResponseSchema,
  logoutResponseSchema,
  personaListResponseSchema,
  type AuthSessionResponse,
  type DemoDiagnosticsResponse,
  type Persona
} from '@slacato/contracts';

interface WireSchema<T> {
  parse(input: unknown): T;
}

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code?: 'UNAUTHORIZED' | 'FORBIDDEN' | 'INVALID_CSRF'
  ) {
    super(status === 401 ? 'Authentication is required.' : 'The request could not be completed.');
  }
}

export async function requestJson<T>(schema: WireSchema<T>, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch((): undefined => undefined);
    const parsed = authErrorResponseSchema.safeParse(body);
    throw new ApiError(response.status, parsed.success ? parsed.data.code : undefined);
  }
  return schema.parse(await response.json());
}

export function fetchSession(signal?: AbortSignal): Promise<AuthSessionResponse> {
  return requestJson(authSessionResponseSchema, '/api/auth/session', { signal });
}

export async function fetchPersonas(signal?: AbortSignal): Promise<readonly Persona[]> {
  return (await requestJson(personaListResponseSchema, '/api/auth/personas', { signal })).personas;
}

export async function fetchCsrf(signal?: AbortSignal): Promise<string> {
  return (await requestJson(csrfResponseSchema, '/api/auth/csrf', { signal })).csrfToken;
}

export function changePersona(userId: string, csrfToken: string) {
  return requestJson(authenticatedMutationResponseSchema, '/api/auth/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ userId })
  });
}

export function endSession(csrfToken: string) {
  return requestJson(logoutResponseSchema, '/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: '{}'
  });
}

export function fetchDiagnostics(signal: AbortSignal | undefined): Promise<DemoDiagnosticsResponse> {
  return requestJson(demoDiagnosticsResponseSchema, '/api/diagnostics', { signal });
}
