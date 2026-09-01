// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { createElement } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advanceGuidedTour,
  advanceGuidedTourFromLogin,
  GuidedTour,
  tourSteps
} from '../../apps/web/src/components/guided-tour';
import { LoginRoute } from '../../apps/web/src/routes/login';

const STORAGE_KEY = 'slacato.guided-tour.v3';
const stepCount = tourSteps.length;

const READY_HEALTH = {
  status: 'ready',
  checks: { database: 'ready', migration: 'ready', redis: 'ready', index: 'ready', model: 'ready' }
};

/** Mutable per-test readiness fixture the mocked `readinessQueryOptions` resolves with. */
let readinessResult: unknown = READY_HEALTH;

const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 0 } }
});

vi.mock('@/api/client', () => ({
  fetchCsrf: () => Promise.resolve('csrf-token'),
  fetchPersonas: () => Promise.resolve([
    { userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner' }
  ])
}));

vi.mock('@/api/session', () => ({
  safeDestination: () => '/deals',
  selectPersonaSession: () => Promise.resolve(),
  sessionRuntime: { finishTransition: () => undefined, generation: 0, accepts: () => true, reconcileAuthoritativeSession: () => Promise.resolve() },
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
    queryFn: () => Promise.resolve(readinessResult),
    retry: false
  })
}));

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return createElement('output', { 'aria-label': 'current location' }, location.pathname);
}

function TourHarness({
  initialPath = '/settings',
  target = 'persona-USR-5001',
  withTarget = true,
  manualNavTo,
  withBackgroundControl = false
}: Readonly<{
  initialPath?: string;
  target?: string;
  withTarget?: boolean;
  /** When set, renders a real router link the test can click to simulate the user navigating away on their own. */
  manualNavTo?: string;
  /** Renders a focusable control outside the tour target, standing in for an unrelated background control (another persona card, a disclosure, etc.) that a required-interaction step must not hand focus to. */
  withBackgroundControl?: boolean;
}>): React.JSX.Element {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
    createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      createElement(
        'main',
        { id: 'main-content' },
        withTarget
          ? createElement(
              'div',
              { 'data-testid': 'tour-target', 'data-tour': target },
              createElement('button', null, target === 'persona-USR-5001' ? 'Continue as Maya Levin' : 'Target control')
            )
          : null,
        withBackgroundControl ? createElement('button', null, 'Background persona') : null,
        manualNavTo !== undefined
          ? createElement(Link, { to: manualNavTo }, 'Go elsewhere')
          : null
      ),
      createElement(GuidedTour),
      createElement(LocationProbe)
    )
  );
}

function LoginHarness(): React.JSX.Element {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
    createElement(
      MemoryRouter,
      { initialEntries: ['/login'] },
      createElement(LoginRoute),
      createElement(LocationProbe)
    )
  );
}

describe('guided tour steps', () => {
  it('covers every graded demo scenario in a single ordered path', () => {
    const targets = tourSteps.map((step) => step.target);
    const routes = tourSteps.map((step) => step.route);
    const scenarios = new Set(tourSteps.map((step) => step.scenario));

    expect(targets[0]).toBe('persona-USR-5001');
    expect(tourSteps[0].action).toBe('login-personas');
    expect(targets.at(-1)).toBe('diagnostics');
    // Scenario 1: an authorized owner generates and inspects a brief for OPP-1001.
    expect(routes).toContain('/deals/OPP-1001');
    expect(targets).toContain('generate-brief');
    expect(targets).toContain('ai-brief');
    // Scenario 2: the restricted deal routes through authority-scoped approvals.
    expect(routes).toContain('/deals/OPP-1003');
    expect(targets).toContain('approvals');
    // Scenario 3: an unauthorized persona reaches an opaque denial.
    expect(targets).toContain('denial-notice');
    // Scenario 4: the generated Slack updates are shown affecting the brief.
    expect(targets).toContain('slack-evidence');
    expect([...scenarios]).toEqual(expect.arrayContaining([
      'Scenario 1 · Authorized brief',
      'Scenario 2 · Restricted deal and approvals',
      'Scenario 3 · Unauthorized attempt',
      'Scenario 4 · Generated Slack updates'
    ]));
  });

  it('waits for the user on every step that needs a real product action', () => {
    const gated = tourSteps.filter((step) => step.requiresInteraction === true);

    // Each persona switch is two real clicks -- pick the person, then apply the change -- so it is
    // two steps, each spotlighting exactly the one control it asks for.
    expect(gated.map((step) => step.target)).toEqual([
      'persona-USR-5001',
      'generate-brief',
      'persona-USR-5003',
      'settings-apply-persona',
      'generate-brief',
      'persona-USR-5005',
      'settings-apply-persona',
      'approval-decision',
      'persona-USR-5007',
      'settings-apply-persona'
    ]);
    for (const step of gated) expect(step.waitingFor).toBeTruthy();
  });
});

describe('advanceGuidedTour', () => {
  beforeEach(() => window.localStorage.clear());

  it('advances only when the completed action belongs to the current step', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: true, stepIndex: 0, dismissed: false }));

    expect(advanceGuidedTour('generate-brief')).toBe(false);
    expect(advanceGuidedTour('login-personas')).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      active: true,
      stepIndex: 1,
      dismissed: false
    });
  });

  it('ignores completed actions while no tour is running', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: false, stepIndex: 0, dismissed: true }));

    expect(advanceGuidedTour('login-personas')).toBe(false);
  });
});

describe('GuidedTour', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    testQueryClient.clear();
    readinessResult = READY_HEALTH;
  });

  it('starts on login and requires an interactive persona choice', async () => {
    render(createElement(TourHarness));

    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    expect(await screen.findByRole('dialog', { name: 'Sign in as the deal owner' })).toBeInTheDocument();
    expect(screen.getByLabelText('current location')).toHaveTextContent('/login');
    expect(screen.getByText(`Step 1 of ${stepCount}`)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('tour-target')).toHaveAttribute('data-tour-active', 'true'));
    expect(screen.getByRole('button', { name: 'Continue as Maya Levin' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByLabelText('current location')).toHaveTextContent('/login');
    expect(screen.getByText(`Step 1 of ${stepCount}`)).toBeInTheDocument();
  });

  // Regression: leaving the tour used to discard the position it had just saved. `close()`
  // persisted the step reached, but the launcher's `open()` called `settle(0)` -- and because
  // closing also sets `dismissed`, hiding the invitation banner, the launcher was the only way
  // back and it always restarted at `/login`. Mid-demo that cost thirteen steps, two persona
  // switches and a recorded approval decision.
  it('resumes at the saved step when the launcher reopens a closed tour', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: false, stepIndex: 4, dismissed: true }));
    render(createElement(TourHarness, { initialPath: '/deals/OPP-1001', target: 'citations' }));

    fireEvent.click(
      screen.getByRole('button', { name: `Resume guided tour at step 5 of ${stepCount}` })
    );

    expect(await screen.findByText(`Step 5 of ${stepCount}`)).toBeInTheDocument();
    // `dismissed` records a decision about the invitation banner, not about the tour, so resuming
    // must not quietly reinstate the banner the user turned off.
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      active: true,
      stepIndex: 4,
      dismissed: true
    });
  });

  it('offers "Start over" as a deliberate choice once resuming is what leaving does', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: true, stepIndex: 4, dismissed: true }));
    render(createElement(TourHarness, { initialPath: '/deals/OPP-1001', target: 'citations' }));
    expect(await screen.findByText(`Step 5 of ${stepCount}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));

    await waitFor(() => expect(screen.getByLabelText('current location')).toHaveTextContent('/login'));
    expect(screen.getByText(`Step 1 of ${stepCount}`)).toBeInTheDocument();
    // Step one has nowhere further back to go, so the control retires rather than sitting there
    // as a no-op.
    expect(screen.queryByRole('button', { name: 'Start over' })).not.toBeInTheDocument();
  });

  it('resumes on Deals at step two after login advances the persisted tour', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: true, stepIndex: 0, dismissed: false }));

    expect(advanceGuidedTourFromLogin()).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      active: true,
      stepIndex: 1,
      dismissed: false
    });

    render(createElement(TourHarness, { initialPath: '/deals', target: 'deal-list' }));

    expect(await screen.findByText(`Step 2 of ${stepCount}`)).toBeInTheDocument();
    expect(screen.getByLabelText('current location')).toHaveTextContent('/deals');
    await waitFor(() => expect(screen.getByTestId('tour-target')).toHaveAttribute('data-tour-active', 'true'));
  });

  it('routes itself to the step destination when a persona change resumes the tour', async () => {
    // Derived, not hardcoded: the step list is edited often enough that a fixed index silently
    // starts testing a different step instead of failing.
    const stepIndex = tourSteps.findIndex(
      (step) => step.target === 'generate-brief' && step.route === '/deals/OPP-1003'
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: true, stepIndex, dismissed: false }));
    render(createElement(TourHarness, { initialPath: '/settings', target: 'generate-brief' }));

    await waitFor(() => expect(screen.getByLabelText('current location')).toHaveTextContent('/deals/OPP-1003'));
  });

  it('renders the launcher on login and advances the tour when a persona is selected', async () => {
    render(createElement(LoginHarness));
    const personaButton = await screen.findByRole('button', { name: 'Continue as Maya Levin' });

    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in as the deal owner' })).toBeInTheDocument();
    fireEvent.click(personaButton);

    await waitFor(() => expect(screen.getByLabelText('current location')).toHaveTextContent('/deals'));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      active: true,
      stepIndex: 1,
      dismissed: false
    });
  });

  it('offers the tour on arrival and remembers a deliberate skip', async () => {
    render(createElement(LoginHarness));

    const invitation = await screen.findByRole('button', { name: 'Start the guided tour' });
    expect(invitation).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Skip the tour' })).not.toBeInTheDocument());
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain('"dismissed":true');
  });

  it('keeps dismissal and recovery controls available while a required target is missing', async () => {
    render(createElement(TourHarness, { withTarget: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    expect(
      await screen.findByText('This step is not ready on screen yet. Wait for it to load, or move on.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip tour' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Close guided tour' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return to this step' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));

    expect(await screen.findByText(`Step 2 of ${stepCount}`)).toBeInTheDocument();
  });

  it('does not show a stale missing-target warning when routed content arrives', async () => {
    vi.useFakeTimers();
    try {
      render(createElement(TourHarness, { withTarget: false }));
      fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));
      await act(() => vi.advanceTimersByTimeAsync(50));
      const target = document.createElement('button');
      target.dataset.tour = 'persona-USR-5001';
      target.textContent = 'Delayed persona choices';
      document.getElementById('main-content')!.append(target);
      await act(async () => Promise.resolve());

      expect(target).toHaveAttribute('data-tour-active', 'true');
      await act(() => vi.advanceTimersByTimeAsync(150));
      expect(
        screen.queryByText('This step is not ready on screen yet. Wait for it to load, or move on.')
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on Escape and saves an inactive resumable state', async () => {
    render(createElement(TourHarness));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain('"active":false');
  });

  it('traps keyboard focus on later steps and restores it to the launcher', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: true, stepIndex: 1, dismissed: false }));
    render(createElement(TourHarness, { initialPath: '/deals', target: 'deal-list' }));
    const launcher = screen.getByRole('button', { name: 'Start guided tour' });
    const next = await screen.findByRole('button', { name: 'Next' });
    expect(next).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close guided tour' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(launcher).toHaveFocus());
  });

  it('discards a corrupted non-integer persisted step index instead of rendering mismatched progress', async () => {
    // Bug: readTourState() only checked the bounds of parsed.stepIndex, not that it was an
    // integer. A fractional value (e.g. from hand-edited or corrupted localStorage) passed the
    // bounds check, so React rendered "Step 3.5 of 17" while tourSteps[2.5] resolved via the
    // `?? tourSteps[0]` fallback to step 0's content ("Sign in as the deal owner") -- a visibly
    // inconsistent header/body pairing. Fixed by requiring Number.isInteger in readTourState.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: 2.5, dismissed: false })
    );

    render(createElement(TourHarness));

    expect(await screen.findByText(`Step 1 of ${stepCount}`)).toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: 'Sign in as the deal owner' })
    ).toBeInTheDocument();
  });

  it('discards a persisted step index that no longer exists in the step list', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: 9999, dismissed: false })
    );

    render(createElement(TourHarness));

    expect(await screen.findByText(`Step 1 of ${stepCount}`)).toBeInTheDocument();
  });

  it('discards a negative persisted step index', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: -3, dismissed: false })
    );

    render(createElement(TourHarness));

    expect(await screen.findByText(`Step 1 of ${stepCount}`)).toBeInTheDocument();
  });

  it('starts fresh instead of crashing when persisted tour state is not valid JSON', async () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');

    render(createElement(TourHarness));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));
    expect(await screen.findByText(`Step 1 of ${stepCount}`)).toBeInTheDocument();
  });

  it('offers only "Continue anyway" -- never a route it cannot return to -- when a route-less step target never appears', async () => {
    // run-progress-detail (index 3) intentionally has no `route`: the run page is reached by the
    // app's own navigation after "Generate Brief", not by the tour. If that target never mounts
    // (e.g. the run page never loaded), there is nowhere for "Return to this step" to send the
    // user back to, so it must not render.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: 3, dismissed: false })
    );

    render(createElement(TourHarness, { initialPath: '/deals/OPP-1001', withTarget: false }));

    expect(
      await screen.findByText('This step is not ready on screen yet. Wait for it to load, or move on.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Return to this step' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue anyway' })).toBeEnabled();
  });

  it('does not force-navigate the user back after they manually leave the current step route', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: 1, dismissed: false })
    );
    render(
      createElement(TourHarness, {
        initialPath: '/deals',
        target: 'deal-list',
        manualNavTo: '/settings'
      })
    );
    await waitFor(() => expect(screen.getByLabelText('current location')).toHaveTextContent('/deals'));

    fireEvent.click(screen.getByRole('link', { name: 'Go elsewhere' }));
    await waitFor(() =>
      expect(screen.getByLabelText('current location')).toHaveTextContent('/settings')
    );

    // Let any effect scheduled off the route change run, then confirm the tour left the user where
    // they navigated instead of yanking them back to the step's route.
    await act(async () => Promise.resolve());
    expect(screen.getByLabelText('current location')).toHaveTextContent('/settings');
    expect(screen.getByText(`Step 2 of ${stepCount}`)).toBeInTheDocument();
  });

  it('holds the current step when the launcher is pressed while a tour is already running', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: 5, dismissed: false })
    );
    render(
      createElement(TourHarness, { initialPath: '/deals/OPP-1001', target: 'slack-evidence' })
    );
    expect(await screen.findByText(`Step 6 of ${stepCount}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    // The launcher resumes; it no longer doubles as an unlabelled reset that throws away a
    // position the user never asked to lose.
    await waitFor(() => expect(screen.getByLabelText('current location')).toHaveTextContent('/deals/OPP-1001'));
    expect(screen.getByText(`Step 6 of ${stepCount}`)).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      active: true,
      stepIndex: 5,
      dismissed: false
    });
  });

  it('marks the dialog modal only on steps that do not require acting on the page behind it', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: 1, dismissed: false })
    );
    render(createElement(TourHarness, { initialPath: '/deals', target: 'deal-list' }));
    const nonInteractiveDialog = await screen.findByRole('dialog');
    expect(nonInteractiveDialog).toHaveAttribute('aria-modal', 'true');
    cleanup();
    window.localStorage.clear();

    render(createElement(TourHarness));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));
    const interactiveDialog = await screen.findByRole('dialog');
    expect(interactiveDialog).not.toHaveAttribute('aria-modal');
  });

  it('removes its window and document listeners when unmounted', async () => {
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
    const documentRemoveSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(createElement(TourHarness));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));
    await screen.findByRole('dialog');

    unmount();

    expect(documentRemoveSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(windowRemoveSpy).toHaveBeenCalledWith(
      'slacato:start-guided-tour',
      expect.any(Function)
    );
    expect(windowRemoveSpy).toHaveBeenCalledWith(
      'slacato:guided-tour-advance',
      expect.any(Function)
    );
    windowRemoveSpy.mockRestore();
    documentRemoveSpy.mockRestore();
  });

  it('ignores a non-finite step index dispatched on the advance event', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: 0, dismissed: false })
    );
    render(createElement(TourHarness));
    await screen.findByText(`Step 1 of ${stepCount}`);

    fireEvent(
      window,
      new CustomEvent('slacato:guided-tour-advance', { detail: { stepIndex: Number.NaN } })
    );

    // A NaN advance must not corrupt the step index; the tour should remain exactly where it was.
    await act(async () => Promise.resolve());
    expect(screen.getByText(`Step 1 of ${stepCount}`)).toBeInTheDocument();
  });

  it('explains a gated Generate Brief step instead of leaving the user stuck on a disabled control', async () => {
    readinessResult = {
      status: 'not_ready',
      checks: { database: 'ready', migration: 'ready', redis: 'ready', index: 'unavailable', model: 'ready' },
      detail: { code: 'DEPENDENCY_UNAVAILABLE', generation: 'disabled' }
    };
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: 2, dismissed: false })
    );

    render(createElement(TourHarness, { initialPath: '/deals/OPP-1001', target: 'generate-brief' }));

    expect(await screen.findByText(/evidence index not ready/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    const proceed = await screen.findByRole('button', { name: 'Continue without generating' });

    fireEvent.click(proceed);

    expect(await screen.findByText(`Step 4 of ${stepCount}`)).toBeInTheDocument();
  });

  it('leaves an unblocked Generate Brief step waiting for the real action as before', async () => {
    readinessResult = READY_HEALTH;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: 2, dismissed: false })
    );

    render(createElement(TourHarness, { initialPath: '/deals/OPP-1001', target: 'generate-brief' }));

    expect(await screen.findByText('Choose Generate Brief to continue.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue without generating' })).not.toBeInTheDocument();
  });

  it('traps Tab within the dialog and the live target on a required-interaction step, never reaching other background controls', async () => {
    render(createElement(TourHarness, { withBackgroundControl: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    const target = await screen.findByRole('button', { name: 'Continue as Maya Levin' });
    await waitFor(() => expect(target).toHaveFocus());
    const background = screen.getByRole('button', { name: 'Background persona' });
    const closeButton = screen.getByRole('button', { name: 'Close guided tour' });
    const skipButton = screen.getByRole('button', { name: 'Skip tour' });

    const visited = new Set<Element | null>();
    for (let step = 0; step < 8; step += 1) {
      fireEvent.keyDown(document, { key: 'Tab' });
      visited.add(document.activeElement);
    }

    expect(visited).not.toContain(background);
    expect(visited).not.toContain(screen.getByRole('button', { name: 'Start guided tour' }));
    // A real trap cycles: it must land back on the target and reach the dialog's own controls.
    expect(visited).toContain(target);
    expect(visited).toContain(closeButton);
    expect(visited).toContain(skipButton);

    // Shift+Tab must wrap backwards within the same closed loop, never escaping to <body>.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(background);
  });

  /**
   * Drives the real component with a mocked target rectangle and asserts where the dialog lands.
   *
   * The earlier version of these tests keyed its rectangle mock on `data-tour="login-personas"`,
   * a target name the tour stopped using, so the mock never fired and both tests only ever
   * measured jsdom's all-zero rectangles. They key on the harness's actual target now.
   */
  async function placeDialogWithTargetRect(
    rect: Readonly<{ top: number; height: number }>,
    viewportHeight: number
  ): Promise<{ side: 'top' | 'bottom'; offset: string; maxHeight: string }> {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewportHeight });
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.dataset?.tour === 'persona-USR-5001')
        return {
          top: rect.top, left: 0, right: 200, bottom: rect.top + rect.height, width: 200,
          height: rect.height, x: 0, y: rect.top, toJSON: () => ({})
        } as DOMRect;
      return originalRect.call(this);
    };
    try {
      render(createElement(TourHarness));
      fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));
      const dialog = await screen.findByRole('dialog', { name: 'Sign in as the deal owner' });
      // The dialog is placed twice: once before the target is measured (the unanchored default),
      // then again from the measured rectangle. Only the second placement is under test, and the
      // spotlight ring renders only once a rectangle exists -- so wait for the ring, not for the
      // dialog to merely carry some offset.
      await waitFor(() => expect(document.querySelector('.ring-4')).not.toBeNull());
      return {
        side: dialog.style.top === '' ? 'bottom' : 'top',
        offset: dialog.style.top === '' ? dialog.style.bottom : dialog.style.top,
        maxHeight: dialog.style.maxHeight
      };
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  }

  /**
   * Reported live at step 15: the dialog rendered as a 144px stub showing a slice of its own
   * footer -- no step number, no title, no body -- and the "Continue anyway" escape sat below the
   * clip, so a required-interaction step whose form was already recorded became a dead end.
   *
   * The unanchored branch derived its height from `anchor?.viewportHeight ?? 0`, so every step
   * with no measured target -- one whose anchor lives inside a closed tab, a page still loading,
   * a form already submitted -- collapsed to the floor meant only for a spotlight that fills the
   * screen. `placeDialogWithTargetRect` waits for the ring before reading placement, so the whole
   * suite measured only the anchored branch and this went unseen.
   */
  it('gives the dialog the free viewport when no target has been measured', async () => {
    const index = tourSteps.findIndex((step) => step.target === 'approval-decision');
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ active: true, stepIndex: index, dismissed: true })
      );
      render(createElement(TourHarness, { initialPath: '/approvals/A-1', withTarget: false }));

      const dialog = await screen.findByRole('dialog');
      await screen.findByText(/not ready on screen yet/);

      expect(Number.parseInt(dialog.style.maxHeight, 10)).toBe(1000 - 16 * 2);
      expect(screen.getByRole('button', { name: 'Continue anyway' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight
      });
    }
  });

  it('drops the dialog below a spotlighted target sitting near the top of a short viewport', async () => {
    const placed = await placeDialogWithTargetRect({ top: 100, height: 40 }, 700);

    expect(placed.side).toBe('bottom');
    expect(placed.offset).toBe('16px');
  });

  it('lifts the dialog above a spotlighted target sitting near the bottom of the viewport', async () => {
    const placed = await placeDialogWithTargetRect({ top: 600, height: 40 }, 700);

    expect(placed.side).toBe('top');
    expect(placed.offset).toBe('16px');
  });

  // Regression: at 390x844 the login persona card's centre lands on 422 and half the viewport is
  // also 422, so the old "is the centre past the midpoint?" test answered false, pinned the
  // dialog to the bottom edge, and laid it straight over "Continue as Maya Levin" -- on a step
  // that requires that very click and therefore offers no Next.
  it('never covers a target whose centre lands exactly on the viewport midpoint', async () => {
    const placed = await placeDialogWithTargetRect({ top: 402, height: 40 }, 844);

    // Spotlight box: top 394, bottom 450. Above it lie 394px, below it 394px -- a genuine tie the
    // rule has to break without ever letting the dialog reach the target.
    expect(placed.side).toBe('top');
    expect(Number.parseInt(placed.maxHeight, 10) + 16).toBeLessThanOrEqual(394);
  });
});

describe('tourSteps data invariants', () => {
  it('never targets the same element on two consecutive steps', () => {
    // The spotlight-positioning effect keys off [active, location.pathname, step.requiresInteraction,
    // step.target]. Two consecutive steps sharing a target, route-presence, and interaction
    // requirement would leave those dependencies unchanged across the transition, so the effect
    // would not re-run and the spotlight could fail to reinitialize for the new step.
    for (let index = 1; index < tourSteps.length; index += 1) {
      expect(tourSteps[index]?.target).not.toBe(tourSteps[index - 1]?.target);
    }
  });
});
