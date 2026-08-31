// @vitest-environment jsdom

import { QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DemoSession, Persona, RunDetailResponse } from '@slacato/contracts';
import { runStatusSchema } from '@slacato/contracts';
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

/** Renders the tour on a run route with the run detail the test staged. */
function renderRunStepWithTour(stepIndex: number): void {
  startAtStep(stepIndex);
  const router = createMemoryRouter(
    [
      {
        id: 'protected-root',
        loader: () => session,
        // The tour is mounted once in the layout, as the app shell mounts it, and a catch-all
        // route stands in for wherever the step advances to.
        Component: () => createElement(Fragment, null, createElement(Outlet), createElement(GuidedTour)),
        children: [
          {
            path: '/runs/:runId',
            Component: () =>
              createElement(
                'main',
                { id: 'main-content' },
                createElement('div', { 'data-tour': 'run-progress-detail' }, 'Progress')
              )
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
}

describe('guided tour: run steps wait for the run to reach a real outcome', () => {
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

  it('releases when the run parks for approval, the outcome that hung the tour in a live demo', async () => {
    // Reported live: scenario 1 sat on "Waiting for this run to reach completed" while the run
    // rested at 82% in awaiting_approval, with no way forward. Which outcome a run reaches is
    // decided by what it produced -- the same unrestricted deal parks on one run and finishes on
    // the next -- so a gate keyed to one expected status hangs on roughly half of real runs.
    const index = stepIndexWhere((step) => step.target === 'run-progress-detail');
    runDetail = runIn('awaiting_approval', false);
    renderRunStepWithTour(index);

    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled());
  });

  it('offers a deliberate way onward at every moment it holds', async () => {
    // Holding is the requested behaviour; trapping a reviewer mid-demo is strictly worse than not
    // gating at all, so the override must render in the same block as the waiting notice.
    const index = stepIndexWhere((step) => step.target === 'run-progress-detail');
    runDetail = runIn('synthesizing', false);
    renderRunStepWithTour(index);

    await screen.findByRole('dialog');
    await screen.findByText(/it is synthesizing right now/);
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));
    await waitFor(() =>
      expect(screen.getByText(`Step ${index + 2} of ${tourSteps.length}`)).toBeInTheDocument()
    );
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

describe('guided tour: no run status can hang a step', () => {
  // Enumerated from the contract rather than hand-listed, so a status added later fails this test
  // instead of silently becoming a state the tour can wait on forever.
  const IN_FLIGHT = ['created', 'retrieving', 'specialists_running', 'synthesizing', 'validating', 'finalizing'];

  for (const status of runStatusSchema.options) {
    it(`${IN_FLIGHT.includes(status) ? 'holds while' : 'releases once'} a run is "${status}"`, async () => {
      const index = stepIndexWhere((step) => step.target === 'run-progress-detail');
      runDetail = runIn(status, !IN_FLIGHT.includes(status));
      renderRunStepWithTour(index);

      await screen.findByRole('dialog');
      const next = () => screen.getByRole('button', { name: /Next/ });
      if (IN_FLIGHT.includes(status)) {
        // A held step must always show the override alongside the reason it is holding.
        await waitFor(() => expect(next()).toBeDisabled());
        expect(screen.getByRole('button', { name: 'Continue anyway' })).toBeEnabled();
      } else {
        await waitFor(() => expect(next()).toBeEnabled());
      }
    });
  }
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

/**
 * Guards the wording of the steps that narrate a state which only exists on a first pass.
 *
 * Approval decisions are taken once and never come back, so a reviewer walking the tour a second
 * time reaches step 14 to find "Pending 0 · No approvals currently require your authority" under
 * copy telling them to open Rina's pending entry, and step 15 with no decision form at all.
 * Nora's inbox at step 11 is empty on every pass, because her own entry unlocks only once the
 * other authorities have decided. Step 20 promised permission facts while spotlighting a section
 * that carries none of them. None of that is a data problem the tour can fix; what it can do is
 * stop describing a screen the reviewer is not looking at.
 */
describe('guided tour: no step narrates a state the reviewer cannot see', () => {
  /** Finds the single step matching a predicate, failing loudly when the tour has moved on. */
  function stepAt(predicate: (step: (typeof tourSteps)[number], index: number) => boolean) {
    const found = tourSteps.filter(predicate);
    expect(found).toHaveLength(1);
    return found[0];
  }

  it('explains why the restricted owner’s own approval inbox is empty instead of implying entries', () => {
    const first = tourSteps.findIndex((candidate) => candidate.target === 'approvals');
    const step = tourSteps[first];

    // The copy has to read true whether Pending holds an entry or none, because which of the
    // four entries is open to her depends on what the other authorities have already decided.
    expect(step?.body).toMatch(/Pending lists only what Nora may decide right now/);
    expect(step?.body).toMatch(/an empty Pending list here is the routing working/);
    expect(step?.body).toMatch(/Decision history/);
    // The old copy claimed she "sees only the decisions she personally holds authority for",
    // which a reviewer reads as "these entries are hers" while looking at none.
    expect(step?.body).not.toMatch(/Nora sees only the decisions/);
  });

  it('tells the approver what a repeat pass looks like when the decision is already recorded', () => {
    const first = tourSteps.findIndex((candidate) => candidate.target === 'approvals');
    const step = tourSteps.filter((candidate) => candidate.target === 'approvals')[1];
    // Two steps visit this inbox: Nora's own deal first, then the approver's. This is the second.
    expect(tourSteps.indexOf(step!)).toBeGreaterThan(first);

    expect(step?.body).toMatch(/Open her pending entry/);
    expect(step?.body).toMatch(/already decided on an earlier pass/);
    expect(step?.body).toMatch(/Decision history/);
  });

  it('warns that the decision form is gone once the decision has been made', () => {
    const step = stepAt((candidate) => candidate.target === 'approval-decision');

    expect(step?.body).toMatch(/already recorded/);
    expect(step?.body).toMatch(/Continue anyway/);
  });

  it('promises only what the spotlit diagnostics section shows, and says where the rest lives', () => {
    const step = stepAt((candidate) => candidate.target === 'diagnostics');

    expect(step?.body).toMatch(/spotlight is on Runtime configuration/);
    // The permission facts live in a sibling section the spotlight never covers, so the step has
    // to place them there rather than fold them into what it is pointing at.
    expect(step?.body).toMatch(/outside the spotlight/);
    expect(step?.body).toMatch(/Canonical permission view/);
  });

  it('describes the Slack step against the brief its anchor actually frames', () => {
    const step = stepAt((candidate) => candidate.target === 'slack-evidence');

    expect(step?.body).toMatch(/generated brief’s own Source Evidence/);
    expect(step?.body).toMatch(/slack\/account_team_updates/);
  });
});
