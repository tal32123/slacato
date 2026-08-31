// @vitest-environment jsdom

import { QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DemoSession, Persona } from '@slacato/contracts';
import { createElement, Fragment } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from '../../apps/web/node_modules/react-router/dist/development/index.js';
import { queryClient } from '../../apps/web/src/api/session';
import { GuidedTour } from '../../apps/web/src/components/guided-tour';
import { SettingsRoute } from '../../apps/web/src/routes/settings';

const STORAGE_KEY = 'slacato.guided-tour.v2';

const personas: readonly Persona[] = [
  { userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner' },
  { userId: 'USR-5003', displayName: 'Nora Chen', role: 'Restricted Account Owner' }
];

const READY_HEALTH = {
  status: 'ready',
  checks: { database: 'ready', migration: 'ready', redis: 'ready', index: 'ready', model: 'ready' }
};

vi.mock('@/api/client', () => ({
  fetchPersonas: () => Promise.resolve(personas),
  fetchCsrf: () => Promise.resolve('csrf-token'),
  fetchReadiness: () => Promise.resolve(READY_HEALTH)
}));

const session: DemoSession = {
  authenticated: true,
  persona: { userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner' },
  version: '11111111-1111-4111-8111-111111111111'
};

afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
});

function renderSettingsWithTour(): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ active: true, stepIndex: 6, dismissed: false })
  );
  const router = createMemoryRouter(
    [
      {
        id: 'protected-root',
        loader: () => session,
        children: [
          {
            path: '/settings',
            Component: () =>
              createElement(Fragment, null, createElement(SettingsRoute), createElement(GuidedTour))
          }
        ]
      }
    ],
    { initialEntries: ['/settings'] }
  );

  render(
    createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))
  );
}

describe('settings-personas tour target', () => {
  it('keeps "Use selected persona" reachable by keyboard during the settings-personas step', async () => {
    // Bug: `data-tour="settings-personas"` wrapped only the persona radio grid. The button the
    // step's own instructions name ("Select Nora Chen and choose \"Use selected persona\" to
    // continue") is a sibling above it, so once Tab was trapped to the spotlighted target, that
    // button became unreachable by keyboard -- the same dead end fixed for Generate Brief,
    // reintroduced here (and on the two other settings-personas steps sharing this markup).
    renderSettingsWithTour();

    await screen.findByRole('dialog');
    // The submit button stays disabled until a different persona is picked -- select Nora Chen,
    // exactly as the step's own instructions ask, before checking reachability.
    fireEvent.click(await screen.findByRole('radio', { name: /Nora Chen/ }));
    const submit = await screen.findByRole('button', { name: 'Use selected persona' });
    expect(submit).toBeEnabled();

    const visited = new Set<Element | null>();
    for (let step = 0; step < 20; step += 1) {
      fireEvent.keyDown(document, { key: 'Tab' });
      visited.add(document.activeElement);
    }

    expect(visited).toContain(submit);
  });
});
