// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DemoSession } from '@slacato/contracts';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from '../../apps/web/node_modules/react-router/dist/development/index.js';
import { AppShell } from '../../apps/web/src/components/app-shell';

const READY_HEALTH = {
  status: 'ready',
  checks: { database: 'ready', migration: 'ready', redis: 'ready', index: 'ready', model: 'ready' }
};

vi.mock('@/api/client', () => ({
  fetchCsrf: () => Promise.resolve('csrf-token'),
  fetchPersonas: () => Promise.resolve([]),
  fetchReadiness: () => Promise.resolve(READY_HEALTH)
}));

vi.mock('@/api/session', () => ({
  safeDestination: () => '/deals',
  selectPersonaSession: () => Promise.resolve(),
  sessionRuntime: {
    finishTransition: () => undefined,
    registerOverlayCloser: () => () => undefined
  },
  readinessQueryOptions: () => ({
    queryKey: ['readiness'],
    queryFn: () => Promise.resolve(READY_HEALTH),
    retry: false
  })
}));

const session: DemoSession = {
  authenticated: true,
  persona: { userId: 'USR-5005', displayName: 'Rina Vale', role: 'Deal Desk Approver' },
  version: '11111111-1111-4111-8111-111111111111'
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  }));
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

function renderShell(): void {
  const router = createMemoryRouter(
    [
      {
        path: '/approvals',
        Component: () => createElement(AppShell, { session, onLogout: () => Promise.resolve() }),
        children: [{ index: true, Component: () => createElement('p', null, 'Pending approvals content') }]
      }
    ],
    { initialEntries: ['/approvals'] }
  );

  render(
    createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))
  );
}

describe('AppShell bottom clearance', () => {
  it('reserves enough space below the main content for the fixed guided-tour launcher at desktop widths', () => {
    // Bug: `lg:pb-10` (40px) reserved less room than the launcher's own footprint -- it sits
    // `bottom-5` (20px) off the viewport edge and stands 44px tall (`h-11`), a 64px band. A page
    // whose content ends flush with the viewport bottom -- a short approvals inbox with no
    // scrolling needed, say -- rendered its last real action (a "Review" button) underneath the
    // launcher. The reserve must clear the launcher's full footprint plus a margin.
    renderShell();

    const main = document.getElementById('main-content');
    expect(main).not.toBeNull();
    expect(main).toHaveClass('lg:pb-20');
    expect(main).not.toHaveClass('lg:pb-10');
  });
});
