// @vitest-environment jsdom

import { QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReadinessHealth } from '@slacato/contracts';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation } from '../../apps/web/node_modules/react-router/dist/development/index.js';
import { queryClient, queryKeys } from '../../apps/web/src/api/session';
import { GenerateBriefAction } from '../../apps/web/src/features/runs/generate-brief-action';

const fetchReadinessMock = vi.fn<() => Promise<ReadinessHealth>>();

const startBriefMock = vi.fn();

vi.mock('@/api/client', () => ({
  fetchReadiness: () => fetchReadinessMock(),
  fetchCsrf: () => Promise.resolve('csrf-token'),
  startBrief: (...args: readonly unknown[]) => startBriefMock(...args)
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

/**
 * Proves the interface says out loud when a Generate Brief request did not start anything.
 *
 * The server answers a request that lands on an already-active run with the same 201 and the same
 * `{ runId }` body it uses for a fresh run, and reports the difference only in `X-Run-Disposition`.
 * A walkthrough caught the consequence: the reviewer presses Generate Brief, is taken to a run
 * created minutes earlier by someone else, and the next screen -- "Watch the work actually happen"
 * -- shows a finished run with nothing to watch.
 */
describe('Generate Brief run disposition', () => {
  it('carries a joined run’s disposition to the run page instead of implying new work started', async () => {
    fetchReadinessMock.mockResolvedValue(READY);
    startBriefMock.mockResolvedValue({ runId: 'run-existing', disposition: 'joined' });
    const seen = renderActionWithRunPage();

    const button = await screen.findByRole('button', { name: 'Generate Brief' });
    await waitFor(() => expect(button).toBeEnabled());
    button.click();

    await waitFor(() => expect(screen.getByTestId('run-page')).toBeInTheDocument());
    expect(seen.path).toBe('/runs/run-existing');
    expect(seen.state).toEqual({ runDisposition: 'joined' });
  });

  it('says nothing about a request that genuinely started a run', async () => {
    fetchReadinessMock.mockResolvedValue(READY);
    startBriefMock.mockResolvedValue({ runId: 'run-new', disposition: 'created' });
    const seen = renderActionWithRunPage();

    const button = await screen.findByRole('button', { name: 'Generate Brief' });
    await waitFor(() => expect(button).toBeEnabled());
    button.click();

    await waitFor(() => expect(screen.getByTestId('run-page')).toBeInTheDocument());
    expect(seen.state).toEqual({ runDisposition: 'created' });
  });
});

/** Renders the action alongside a stand-in run page that records how it was navigated to. */
function renderActionWithRunPage(): { path?: string; state?: unknown } {
  const seen: { path?: string; state?: unknown } = {};
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
      },
      {
        path: '/runs/:runId',
        Component: () => {
          const location = useLocation();
          seen.path = location.pathname;
          seen.state = location.state;
          return createElement('p', { 'data-testid': 'run-page' }, 'run page');
        }
      }
    ],
    { initialEntries: ['/deals/OPP-1001'] }
  );
  render(
    createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))
  );
  return seen;
}

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
