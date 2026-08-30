// @vitest-environment jsdom

import { createElement } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
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
  withTarget = true
}: Readonly<{ initialPath?: string; target?: string; withTarget?: boolean }>): React.JSX.Element {
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
});
