// @vitest-environment jsdom

import { QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DemoSession, Persona, RunDetailResponse } from '@slacato/contracts';
import { createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryRouter,
  Link,
  Outlet,
  RouterProvider
} from '../../apps/web/node_modules/react-router/dist/development/index.js';
import { queryClient } from '../../apps/web/src/api/session';
import { GuidedTour, tourSteps } from '../../apps/web/src/components/guided-tour';
import { LoginRoute } from '../../apps/web/src/routes/login';
import { SettingsRoute } from '../../apps/web/src/routes/settings';

const STORAGE_KEY = 'slacato.guided-tour.v3';

const personas: readonly Persona[] = [
  { userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner' },
  { userId: 'USR-5003', displayName: 'Nora Chen', role: 'Restricted Account Owner' },
  { userId: 'USR-5005', displayName: 'Rina Vale', role: 'Deal Desk Approver' },
  { userId: 'USR-5007', displayName: 'Harper Noor', role: 'Unauthorized Requester' }
];

const READY_HEALTH = {
  status: 'ready',
  checks: { database: 'ready', migration: 'ready', redis: 'ready', index: 'ready', model: 'ready' }
};

const session: DemoSession = {
  authenticated: true,
  persona: { userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner' },
  version: '11111111-1111-4111-8111-111111111111'
};

/** Mutable run detail the mocked run endpoint answers with, so a test can drive run state. */
let runDetail: RunDetailResponse;

/** Builds a run detail response in the requested workflow state. */
function runIn(status: RunDetailResponse['status'], terminal: boolean): RunDetailResponse {
  return {
    sessionVersion: session.version,
    runId: 'RUN-1',
    opportunityId: 'OPP-1001',
    opportunityName: 'Northstar Foods Cooperative - Global Access Renewal',
    accountName: 'Northstar Foods Cooperative',
    initiatedBy: 'Maya Levin',
    status,
    terminal,
    version: 1,
    watermark: 'evt-1',
    watermarkSequence: 1,
    updatedAt: '2026-04-18T00:00:00.000Z',
    progress: {
      phase: status,
      retrievalCount: 7,
      validationRetries: 0,
      completedSections: [],
      timeline: []
    },
    brief: null,
    warnings: []
  } as unknown as RunDetailResponse;
}

vi.mock('@/api/client', () => ({
  fetchPersonas: () => Promise.resolve(personas),
  fetchCsrf: () => Promise.resolve('csrf-token'),
  fetchReadiness: () => Promise.resolve(READY_HEALTH),
  fetchSession: () => Promise.resolve(session),
  fetchRunDetail: () => Promise.resolve(runDetail),
  startBrief: () => Promise.resolve({ runId: 'RUN-1' }),
  cancelRun: () => Promise.resolve(undefined),
  fetchRuns: () => Promise.resolve({ sessionVersion: session.version, runs: [] })
}));

beforeEach(() => {
  runDetail = runIn('specialists_running', false);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
});

/** Finds the index of the first tour step matching a predicate, failing loudly when absent. */
function stepIndexWhere(match: (step: (typeof tourSteps)[number]) => boolean): number {
  const index = tourSteps.findIndex(match);
  if (index === -1) throw new Error('No guided tour step matched the expected shape');
  return index;
}

/** Starts the tour at a chosen step before the component under test mounts. */
function startAtStep(stepIndex: number): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ active: true, stepIndex, dismissed: false })
  );
}

/** Renders settings behind a protected route with the guided tour mounted alongside it. */
function renderSettingsWithTour(path = '/settings'): void {
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
    { initialEntries: [path] }
  );
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router })
    )
  );
}

describe('guided tour: the spotlight frames only the control to act on', () => {
  it('frames the single named persona card on login, not every persona in the group', async () => {
    // Reported: "if i need to click on maya, it should only highlight maya and everything else
    // gray". The login step's target wrapped the whole scenario persona grid, so the spotlight
    // lit Maya, Nora, Rina and Harper alike while the copy named exactly one of them.
    startAtStep(0);
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          RouterProvider,
          {
            router: createMemoryRouter([{ path: '/login', Component: LoginRoute }], {
              initialEntries: ['/login']
            })
          }
        )
      )
    );

    await screen.findByRole('button', { name: /Continue as Maya Levin/ });
    const framed = document.querySelector(`[data-tour="${tourSteps[0].target}"]`);

    expect(framed).not.toBeNull();
    expect(framed?.textContent).toContain('Maya Levin');
    for (const other of ['Nora Chen', 'Rina Vale', 'Harper Noor'])
      expect(framed?.textContent).not.toContain(other);
  });

  it('frames one persona card at a time on the settings switch, not the whole persona section', async () => {
    const index = stepIndexWhere(
      (step) => step.route === '/settings' && step.body.includes('Nora Chen')
    );
    startAtStep(index);
    renderSettingsWithTour();

    await screen.findByRole('dialog');
    await screen.findByRole('radio', { name: /Nora Chen/ });
    const framed = document.querySelector(`[data-tour="${tourSteps[index].target}"]`);

    expect(framed).not.toBeNull();
    expect(framed?.textContent).toContain('Nora Chen');
    // The section wrapper also holds every other persona and the heading; a precise target does not.
    expect(framed?.textContent).not.toContain('Maya Levin');
    expect(framed?.textContent).not.toContain('Active persona');
  });

  it('does not advance when an arrow key selects a persona the step never offered', async () => {
    // Every persona radio shares one radio group, so arrow keys move focus AND selection to a
    // sibling the spotlight does not frame and the focus trap does not admit. Reporting the
    // selection anonymously would advance the step with the wrong person chosen and the persona
    // cards then sealed behind the backdrop.
    const index = stepIndexWhere(
      (step) => step.route === '/settings' && step.body.includes('Nora Chen')
    );
    startAtStep(index);
    renderSettingsWithTour();

    await screen.findByRole('dialog');
    fireEvent.click(await screen.findByRole('radio', { name: /Maya Levin/ }));

    await waitFor(() => expect(screen.getByText(`Step ${index + 1} of ${tourSteps.length}`)).toBeInTheDocument());
    expect(document.querySelector(`[data-tour="${tourSteps[index].target}"]`)).not.toBeNull();
  });

  it('moves the spotlight onto "Use selected persona" once the named persona is selected', async () => {
    // Selecting the radio is only half the action. The apply button must become the spotlighted
    // target rather than staying behind the dimmed backdrop where it cannot be clicked.
    const index = stepIndexWhere(
      (step) => step.route === '/settings' && step.body.includes('Nora Chen')
    );
    startAtStep(index);
    renderSettingsWithTour();

    await screen.findByRole('dialog');
    fireEvent.click(await screen.findByRole('radio', { name: /Nora Chen/ }));

    await waitFor(() => {
      const framed = document.querySelector(`[data-tour="${tourSteps[index + 1].target}"]`);
      expect(framed).not.toBeNull();
      expect(framed?.textContent).toContain('Use selected persona');
    });
  });
});

describe('guided tour: run steps wait for the run to reach a real outcome', () => {
  /** Renders the tour on a run route with the run detail the test staged. */
  function renderRunStepWithTour(stepIndex: number): void {
    startAtStep(stepIndex);
    const router = createMemoryRouter(
      [
        {
          id: 'protected-root',
          loader: () => session,
          children: [
            {
              path: '/runs/:runId',
              Component: () =>
                createElement(
                  Fragment,
                  null,
                  createElement('main', { id: 'main-content' }, [
                    createElement('div', { key: 'target', 'data-tour': 'run-progress-detail' }, 'Progress')
                  ]),
                  createElement(GuidedTour)
                )
            }
          ]
        }
      ],
      { initialEntries: ['/runs/RUN-1'] }
    );
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router })
      )
    );
  }

  it('holds the step while the run is still working instead of letting the user walk past it', async () => {
    const index = stepIndexWhere((step) => step.target === 'run-progress-detail');
    runDetail = runIn('specialists_running', false);
    renderRunStepWithTour(index);

    await screen.findByRole('dialog');
    // Wait for the live run state to actually arrive before asserting the hold, so this cannot
    // pass merely because the tour has not read the run yet.
    await screen.findByText(/it is specialists running right now/);
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
  });

  it('releases the step once the run reaches the outcome the step describes', async () => {
    const index = stepIndexWhere((step) => step.target === 'run-progress-detail');
    runDetail = runIn('completed', true);
    renderRunStepWithTour(index);

    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled());
  });

  it('releases the step with an honest message when the run fails instead of trapping the user', async () => {
    const index = stepIndexWhere((step) => step.target === 'run-progress-detail');
    runDetail = runIn('failed', true);
    renderRunStepWithTour(index);

    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled());
    expect(screen.getByRole('status').textContent).toMatch(/did not finish|failed|ended/i);
  });
});

describe('guided tour: a held run step is never a dead end', () => {
  it('offers a deliberate way onward when the run state cannot be read at all', async () => {
    // The waiting branch also covers "no data yet", which never resolves when the tour cannot
    // reach the run -- no protected session on the route, for instance. Next stays disabled, the
    // arrow key is refused and the missing-target block does not render, so without an explicit
    // escape the only remaining exits abandon the tour.
    const index = stepIndexWhere((step) => step.target === 'run-progress-detail');
    startAtStep(index);
    const router = createMemoryRouter(
      [
        {
          Component: () => createElement(Fragment, null, createElement(Outlet), createElement(GuidedTour)),
          children: [
            {
              path: '/runs/:runId',
              Component: () =>
                createElement('main', { id: 'main-content' },
                  createElement('div', { 'data-tour': 'run-progress-detail' }, 'Progress'))
            },
            { path: '*', Component: () => createElement('main', { id: 'main-content' }, 'Elsewhere') }
          ]
        }
      ],
      { initialEntries: ['/runs/RUN-1'] }
    );
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router })
      )
    );

    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();

    const escape = await screen.findByRole('button', { name: 'Continue anyway' });
    fireEvent.click(escape);

    await waitFor(() =>
      expect(screen.getByText(`Step ${index + 2} of ${tourSteps.length}`)).toBeInTheDocument()
    );
  });
});

describe('guided tour: following the step’s own instruction is never "stepping off the path"', () => {
  /**
   * Renders a stand-in list page with a real link at a chosen step. The tour is mounted once in a
   * layout route, exactly as the real application mounts it in the app shell -- remounting it per
   * route would reset the per-step routing state the tour uses to tell a followed instruction
   * apart from a wander, and would test the harness rather than the product.
   */
  function renderListStepWithTour(stepIndex: number, from: string, to: string): void {
    startAtStep(stepIndex);
    const list = () =>
      createElement(
        'main',
        { id: 'main-content' },
        createElement(
          'div',
          { 'data-tour': tourSteps[stepIndex].target },
          createElement(Link, { to }, 'Open the workspace')
        )
      );
    const router = createMemoryRouter(
      [
        {
          id: 'protected-root',
          loader: () => session,
          Component: () => createElement(Fragment, null, createElement(Outlet), createElement(GuidedTour)),
          children: [
            { path: from, Component: list },
            { path: to, Component: () => createElement('main', { id: 'main-content' }, 'Destination') }
          ]
        }
      ],
      { initialEntries: [from] }
    );
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router })
      )
    );
  }

  it('advances instead of warning when the user opens the deal workspace the step told them to open', async () => {
    // Reported: "it tells me i'm on wrong place when i clicked what it wanted". The deal-list
    // step's copy says "Continue to open that workspace"; obeying it changed the route, the
    // target vanished, and the tour accused the user of leaving the guided path.
    const index = stepIndexWhere((step) => step.target === 'deal-list' && step.route === '/deals');
    renderListStepWithTour(index, '/deals', '/deals/OPP-1001');

    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('link', { name: 'Open the workspace' }));

    await waitFor(() =>
      expect(screen.getByText(`Step ${index + 2} of ${tourSteps.length}`)).toBeInTheDocument()
    );
    expect(screen.queryByText(/stepped off the guided path/)).not.toBeInTheDocument();
  });

  it('advances instead of warning when the user opens the approval entry the step told them to open', async () => {
    const index = stepIndexWhere(
      (step) => step.target === 'approvals' && step.body.includes('Open her pending entry')
    );
    renderListStepWithTour(index, '/approvals', '/approvals/approval_subject_1');

    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('link', { name: 'Open the workspace' }));

    await waitFor(() =>
      expect(screen.getByText(`Step ${index + 2} of ${tourSteps.length}`)).toBeInTheDocument()
    );
    expect(screen.queryByText(/stepped off the guided path/)).not.toBeInTheDocument();
  });

  it('still warns when the user leaves for a route no step instruction invited', async () => {
    // The off-path warning is correct behaviour and must survive the fix -- only the two steps
    // whose own copy invites a navigation are exempt.
    const index = stepIndexWhere((step) => step.target === 'deal-list' && step.route === '/deals');
    renderListStepWithTour(index, '/deals', '/diagnostics');

    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('link', { name: 'Open the workspace' }));

    await waitFor(() =>
      expect(screen.getByText(/stepped off the guided path/)).toBeInTheDocument()
    );
  });
});
