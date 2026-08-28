import {
  authSessionResponseSchema, authenticatedMutationResponseSchema, csrfResponseSchema,
  logoutResponseSchema, personaListResponseSchema, type AuthSessionResponse, type Persona
} from '@slacato/contracts';

export class AuthApiError extends Error {
  public constructor(public readonly status: number) {
    super('The authentication request could not be completed.');
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  if (!response.ok) throw new AuthApiError(response.status);
  return response.json() as Promise<unknown>;
}

export async function listPersonas(signal?: AbortSignal): Promise<readonly Persona[]> {
  return personaListResponseSchema.parse(await request('/api/auth/personas', { signal })).personas;
}

export async function getSession(signal?: AbortSignal): Promise<AuthSessionResponse> {
  return authSessionResponseSchema.parse(await request('/api/auth/session', { signal }));
}

export async function getCsrf(signal?: AbortSignal): Promise<string> {
  return csrfResponseSchema.parse(await request('/api/auth/csrf', { signal })).csrfToken;
}

export async function selectPersona(userId: string, csrfToken: string): Promise<Extract<AuthSessionResponse, { authenticated: true }>> {
  const payload = authenticatedMutationResponseSchema.parse(await request('/api/auth/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ userId })
  }));
  return payload.session;
}

export async function logout(csrfToken: string): Promise<void> {
  logoutResponseSchema.parse(await request('/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: '{}'
  }));
}
