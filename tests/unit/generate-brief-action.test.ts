// @vitest-environment jsdom

import { QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReadinessHealth } from '@slacato/contracts';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from '../../apps/web/node_modules/react-router/dist/development/index.js';
import { queryClient, queryKeys } from '../../apps/web/src/api/session';
import { GenerateBriefAction } from '../../apps/web/src/features/runs/generate-brief-action';

const fetchReadinessMock = vi.fn<() => Promise<ReadinessHealth>>();

vi.mock('@/api/client', () => ({
  fetchReadiness: () => fetchReadinessMock(),
  startBrief: vi.fn()
}));

const READY: ReadinessHealth = {
  status: 'ready',
  checks: { database: 'ready', migration: 'ready', redis: 'ready', index: 'ready', model: 'ready' }
};

const INDEX_NOT_READY: ReadinessHealth = {
  status: 'not_ready',
  checks: { database: 'ready', migration: 'ready', redis: 'ready', index: 'unavailable', model: 'ready' },
  detail: { code: 'DEPENDENCY_UNAVAILABLE', generation: 'disabled' }
};

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.clearAllMocks();
});

describe('Generate Brief readiness gate', () => {
  it('enables Generate Brief once readiness reports ready', async () => {
    fetchReadinessMock.mockResolvedValue(READY);
    renderAction();

    const button = await screen.findByRole('button', { name: 'Generate Brief' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('disables Generate Brief with an honest, specific reason when the evidence index is not ready', async () => {
    fetchReadinessMock.mockResolvedValue(INDEX_NOT_READY);
    renderAction();

    const button = await screen.findByRole('button', { name: 'Generate Brief' });
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByText(/evidence index not ready/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Check Diagnostics/i })).toHaveAttribute(
      'href',
      '/diagnostics'
    );
  });

  it('keeps a working button enabled when the readiness check itself fails', async () => {
    fetchReadinessMock.mockRejectedValue(new Error('network error'));
    renderAction();

    const button = await screen.findByRole('button', { name: 'Generate Brief' });
    await waitFor(() => expect(fetchReadinessMock).toHaveBeenCalled());
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

function renderAction(): void {
  queryClient.removeQueries({ queryKey: queryKeys.readiness });
  const router = createMemoryRouter(
    [
      {
        path: '/deals/OPP-1001',
        Component: () =>
          createElement(GenerateBriefAction, {
            opportunityId: 'OPP-1001',
            sessionVersion: '11111111-1111-4111-8111-111111111111'
          })
      }
    ],
    { initialEntries: ['/deals/OPP-1001'] }
  );

  render(
    createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))
  );
}
