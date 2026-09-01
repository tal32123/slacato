// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { act, cleanup, render, screen } from '@testing-library/react';
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
    registerOverlayCloser: () => () => undefined,
    generation: 0,
    accepts: () => true,
    reconcileAuthoritativeSession: () => Promise.resolve()
  },
  queryKeys: {
    session: ['session'],
    personas: ['personas'],
    readiness: ['readiness'],
    csrf: (version: string) => ['csrf', version],
    scoped: (version: string, resource: string) => ['scoped', version, resource]
  },
  SessionInvalidatedError: class SessionInvalidatedError extends Error {},
  sessionQueryOptions: () => ({
    queryKey: ['session'],
    queryFn: () => Promise.resolve({ authenticated: false }),
    retry: false
  }),
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

/**
 * Renders the shell over two sibling routes so a real navigation can be driven, and returns the
 * router so the test can navigate. The second route's content carries a focusable control, which
 * stands in for anything that deliberately claims focus while the shell owes a frame.
 */
function renderShellForNavigation(): ReturnType<typeof createMemoryRouter> {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: () => createElement(AppShell, { session, onLogout: () => Promise.resolve() }),
        children: [
          { path: 'approvals', Component: () => createElement('p', null, 'Pending approvals content') },
          {
            path: 'settings',
            Component: () => createElement('button', { type: 'button' }, 'Claimed control')
          }
        ]
      }
    ],
    { initialEntries: ['/approvals'] }
  );

  render(
    createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))
  );
  return router;
}

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

describe('AppShell route-change focus', () => {
  /**
   * Regression coverage for the guided tour's flakiest CI failure ("Escape then the launcher
   * resumes the same step", tour-robustness.spec.ts), which failed on trees byte-identical to
   * ones that had just passed -- run 33515204336 against the very same tree as the passing
   * 33514800961.
   *
   * The shell moves focus to <main> on a route change, deferred to a frame so the new route's
   * content exists to focus into. A frame is not produced on any schedule a loaded CI runner is
   * obliged to keep, so that move can land long after something else deliberately claimed focus.
   * Closing the guided tour does exactly that: it returns focus to its launcher on the commit
   * that closes (deliberately not on a frame -- see aa5cc30). The navigation that opened the step
   * then stole focus straight back to <main>, stranding a keyboard user with no way to resume,
   * and reading in CI as "launcher present, correctly labelled, never focused".
   *
   * Route-change focus is a default for when nothing else claims focus, not an override of one
   * that did. Holding the frame rather than running it is the assertion: the contract must hold
   * however late the frame lands. This is deliberately a jsdom test and not an end-to-end one --
   * the contract is entirely about the order of a focus claim and a deferred frame, and driving
   * that order through a real browser makes the test depend on the very scheduling it is meant to
   * pin down (an end-to-end version of this failed in CI while passing locally, for that reason).
   */
  it('does not steal focus claimed while its route-change frame was still owed', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    const router = renderShellForNavigation();
    const main = document.getElementById('main-content');
    // The initial location is a POP, which the shell deliberately does not focus on, so nothing
    // is owed yet and focus starts where the browser left it.
    expect(frames).toHaveLength(0);

    await act(async () => {
      await router.navigate('/settings');
    });
    // The navigation's focus move is now owed but not yet delivered.
    expect(frames).toHaveLength(1);

    const claimed = screen.getByRole('button', { name: 'Claimed control' });
    claimed.focus();
    expect(claimed).toHaveFocus();

    // The frame finally lands, arbitrarily late.
    for (const frame of frames.splice(0)) frame(0);

    expect(claimed).toHaveFocus();
    expect(main).not.toHaveFocus();
  });

  /**
   * The other half of the contract: when nothing else has claimed focus, the route change must
   * still move it to <main>. Without this, guarding the steal above could silently disable the
   * focus move entirely and strand a keyboard user on the nav link they just activated
   * (commit 220e722).
   */
  it('still moves focus to main content when nothing else claimed it', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    const router = renderShellForNavigation();

    await act(async () => {
      await router.navigate('/settings');
    });
    for (const frame of frames.splice(0)) frame(0);

    expect(document.getElementById('main-content')).toHaveFocus();
  });
});

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
