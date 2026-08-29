// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => {
  class ApiError extends Error {
    public constructor(
      public readonly status: number,
      public readonly code?: 'UNAUTHORIZED' | 'FORBIDDEN' | 'INVALID_CSRF'
    ) {
      super('The request could not be completed.');
    }
  }

  return {
    ApiError,
    changePersona: vi.fn(),
    endSession: vi.fn(),
    fetchCsrf: vi.fn(),
    fetchDiagnostics: vi.fn(),
    fetchPersonas: vi.fn(),
    fetchSession: vi.fn()
  };
});

vi.mock('@/api/client', () => client);

import { selectPersonaSession, sessionRuntime } from '../../apps/web/src/api/session';

afterEach(() => {
  sessionRuntime.finishTransition();
  vi.clearAllMocks();
});

it('surfaces a rejected persona selection without reconciling an unchanged session', async () => {
  const rejection = new client.ApiError(403, 'INVALID_CSRF');
  client.changePersona.mockRejectedValueOnce(rejection);
  client.fetchSession.mockResolvedValueOnce({
    authenticated: true,
    persona: { userId: 'USR-5002', displayName: 'Owen Patel', role: 'Account Owner' },
    version: 'existing-session'
  });

  await expect(selectPersonaSession('USR-5001', 'stale-token')).rejects.toBe(rejection);

  expect(client.fetchSession).not.toHaveBeenCalled();
  expect(sessionRuntime.transitioning).toBe(false);
});
