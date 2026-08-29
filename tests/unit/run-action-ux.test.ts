// @vitest-environment jsdom

import { QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DemoSession, RunDetailResponse, RunStatus } from '@slacato/contracts';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from '../../apps/web/node_modules/react-router/dist/development/index.js';
import { queryClient, queryKeys } from '../../apps/web/src/api/session';
import { RunRoute } from '../../apps/web/src/routes/run';

const session: DemoSession = {
  authenticated: true,
  persona: { userId: 'USR-1', displayName: 'Maya Chen', role: 'Account Executive' },
  version: '11111111-1111-4111-8111-111111111111'
};

beforeEach(() => {
  vi.stubGlobal('EventSource', class {
    public addEventListener(): void {}
    public close(): void {}
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('run detail actions', () => {
  it.each(['failed', 'cancelled', 'rejected'] satisfies RunStatus[])(
    'offers a new run from the deal when the current run is %s',
    async (status) => {
      renderRun(status, true);

      const rerun = await screen.findByRole('link', { name: 'Return to deal and run again' });
      expect(rerun).toHaveAttribute('href', '/deals/OPP-1001');
      expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
      expect(screen.getByText(/audit history/i)).toBeInTheDocument();
    }
  );

  it('offers cancellation only while processing is active', async () => {
    renderRun('specialists_running', false);

    expect(await screen.findByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
    expect(screen.getByText(/run is active/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Return to deal and run again' })).not.toBeInTheDocument();
  });
});

function renderRun(status: RunStatus, terminal: boolean): void {
  const detail = runDetail(status, terminal);
  queryClient.setQueryData(queryKeys.scoped(session.version, `run:${detail.runId}`), detail);
  const router = createMemoryRouter([{
    id: 'protected-root',
    loader: () => session,
    children: [{ path: '/runs/:runId', loader: () => detail, Component: RunRoute }]
  }], { initialEntries: [`/runs/${detail.runId}`] });

  render(createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })));
}

function runDetail(status: RunStatus, terminal: boolean): RunDetailResponse {
  const now = new Date().toISOString();
  return {
    sessionVersion: session.version,
    runId: `run_${status}`,
    opportunityId: 'OPP-1001',
    opportunityName: 'Northwind renewal',
    accountName: 'Northwind',
    initiatedBy: 'USR-1',
    status,
    version: 3,
    watermark: null,
    watermarkSequence: 0,
    terminal,
    createdAt: now,
    updatedAt: now,
    progress: {
      phase: status,
      retrievalCount: 12,
      validationRetries: 0,
      specialists: [
        { name: 'conversation', status: terminal ? 'failed' : 'running' },
        { name: 'stakeholder', status: 'pending' },
        { name: 'commercial', status: 'pending' }
      ],
      completedSections: [],
      timeline: []
    }
  };
}
