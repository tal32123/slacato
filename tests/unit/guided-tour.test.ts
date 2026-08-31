// @vitest-environment jsdom

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

const STORAGE_KEY = 'slacato.guided-tour.v2';
const stepCount = tourSteps.length;

vi.mock('@/api/client', () => ({
  fetchCsrf: () => Promise.resolve('csrf-token'),
  fetchPersonas: () => Promise.resolve([
    { userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner' }
  ])
}));

vi.mock('@/api/session', () => ({
  safeDestination: () => '/deals',
  selectPersonaSession: () => Promise.resolve(),
  sessionRuntime: { finishTransition: () => undefined }
}));

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return createElement('output', { 'aria-label': 'current location' }, location.pathname);
}

function TourHarness({
  initialPath = '/settings',
  target = 'login-personas',
  withTarget = true,
  manualNavTo
}: Readonly<{
  initialPath?: string;
  target?: string;
  withTarget?: boolean;
  /** When set, renders a real router link the test can click to simulate the user navigating away on their own. */
  manualNavTo?: string;
}>): React.JSX.Element {
  return createElement(
    MemoryRouter,
    { initialEntries: [initialPath] },
    createElement(
      'main',
      { id: 'main-content' },
      withTarget
        ? createElement(
            'div',
            { 'data-testid': 'tour-target', 'data-tour': target },
            createElement('button', null, target === 'login-personas' ? 'Continue as Maya Levin' : 'Target control')
          )
        : null,
      manualNavTo !== undefined
        ? createElement(Link, { to: manualNavTo }, 'Go elsewhere')
        : null
    ),
    createElement(GuidedTour),
    createElement(LocationProbe)
  );
}

function LoginHarness(): React.JSX.Element {
  return createElement(
    MemoryRouter,
    { initialEntries: ['/login'] },
    createElement(LoginRoute),
    createElement(LocationProbe)
  );
}

describe('guided tour steps', () => {
  it('covers every graded demo scenario in a single ordered path', () => {
    const targets = tourSteps.map((step) => step.target);
    const routes = tourSteps.map((step) => step.route);
    const scenarios = new Set(tourSteps.map((step) => step.scenario));

    expect(targets[0]).toBe('login-personas');
    expect(targets.at(-1)).toBe('diagnostics');
    // Scenario 1: an authorized owner generates and inspects a brief for OPP-1001.
    expect(routes).toContain('/deals/OPP-1001');
    expect(targets).toContain('generate-brief');
    expect(targets).toContain('citations');
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

    expect(gated.map((step) => step.target)).toEqual([
      'login-personas',
      'generate-brief',
      'settings-personas',
      'generate-brief',
      'settings-personas',
      'approval-decision',
      'settings-personas'
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
  afterEach(cleanup);

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

  it('resets saved progress when the launcher is opened', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: false, stepIndex: 4, dismissed: true }));
    render(createElement(TourHarness));

    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    await waitFor(() => expect(screen.getByLabelText('current location')).toHaveTextContent('/login'));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      active: true,
      stepIndex: 0,
      dismissed: false
    });
    expect(screen.getByText(`Step 1 of ${stepCount}`)).toBeInTheDocument();
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: true, stepIndex: 7, dismissed: false }));
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
      target.dataset.tour = 'login-personas';
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

  it('resets fully to step one when the launcher is clicked while a tour is already running', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ active: true, stepIndex: 5, dismissed: false })
    );
    render(
      createElement(TourHarness, { initialPath: '/deals/OPP-1001', target: 'slack-evidence' })
    );
    expect(await screen.findByText(`Step 6 of ${stepCount}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    await waitFor(() => expect(screen.getByLabelText('current location')).toHaveTextContent('/login'));
    expect(screen.getByText(`Step 1 of ${stepCount}`)).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      active: true,
      stepIndex: 0,
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
