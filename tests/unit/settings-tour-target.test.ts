// @vitest-environment jsdom

import { QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DemoSession, Persona } from '@slacato/contracts';
import { createElement, Fragment } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from '../../apps/web/node_modules/react-router/dist/development/index.js';
import { queryClient } from '../../apps/web/src/api/session';
import { GuidedTour, tourSteps } from '../../apps/web/src/components/guided-tour';
import { SettingsRoute } from '../../apps/web/src/routes/settings';

const STORAGE_KEY = 'slacato.guided-tour.v3';

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

/** The step that asks the user to pick Nora Chen, found by what it says rather than by index. */
const selectPersonaStep = tourSteps.findIndex(
  (step) => step.route === '/settings' && step.body.includes('Nora Chen')
);

function renderSettingsWithTour(stepIndex = selectPersonaStep): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ active: true, stepIndex, dismissed: false })
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

describe('settings persona switch tour targets', () => {
  it('spotlights only the named persona while the step asks the user to select them', async () => {
    // Reported: "if i need to click on maya, it should only highlight maya and everything else
    // gray". The step used to target a wrapper holding every persona, the heading, and the submit
    // button, so the spotlight lit the entire section the copy had just narrowed to one person.
    renderSettingsWithTour();

    await screen.findByRole('dialog');
    await screen.findByRole('radio', { name: /Nora Chen/ });
    const framed = document.querySelector(`[data-tour="${tourSteps[selectPersonaStep].target}"]`);

    expect(framed).not.toBeNull();
    expect(framed?.textContent).toContain('Nora Chen');
    expect(framed?.textContent).not.toContain('Maya Levin');
  });

  it('keeps "Use selected persona" spotlighted and keyboard-reachable on the step that asks for it', async () => {
    // Applying the change is a second, separate click, so it is a second step that spotlights the
    // button itself. Reaching it by keyboard matters as much as reaching it by mouse: the focus
    // trap admits the spotlighted target and nothing else behind the backdrop.
    renderSettingsWithTour(selectPersonaStep + 1);

    await screen.findByRole('dialog');
    // The submit button stays disabled until a different persona is picked, so pick one first.
    fireEvent.click(await screen.findByRole('radio', { name: /Nora Chen/ }));
    const submit = await screen.findByRole('button', { name: 'Use selected persona' });
    expect(submit).toBeEnabled();
    expect(submit).toHaveAttribute('data-tour', tourSteps[selectPersonaStep + 1].target);

    const visited = new Set<Element | null>();
    for (let step = 0; step < 20; step += 1) {
      fireEvent.keyDown(document, { key: 'Tab' });
      visited.add(document.activeElement);
    }

    expect(visited).toContain(submit);
  });

  it('moves the spotlight to the apply button as soon as the persona is selected', async () => {
    renderSettingsWithTour();

    await screen.findByRole('dialog');
    fireEvent.click(await screen.findByRole('radio', { name: /Nora Chen/ }));

    // Advancing on selection is what keeps the apply button out from behind the dimmed backdrop.
    expect(await screen.findByRole('heading', { name: 'Apply the persona change' })).toBeInTheDocument();
  });
});
