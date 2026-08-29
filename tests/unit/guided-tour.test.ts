// @vitest-environment jsdom

import { createElement } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceGuidedTourFromLogin, GuidedTour } from '../../apps/web/src/components/guided-tour';
import { LoginRoute } from '../../apps/web/src/routes/login';

vi.mock('@/api/client', () => ({
  fetchCsrf: () => Promise.resolve('csrf-token'),
  fetchPersonas: () => Promise.resolve([
    { userId: 'seller-alex', displayName: 'Alex Seller', role: 'Account Owner' }
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
            createElement('button', null, target === 'login-personas' ? 'Continue as Alex Seller' : 'Target control')
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

describe('GuidedTour', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it('starts on login and requires an interactive persona choice', async () => {
    render(createElement(TourHarness));

    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    expect(await screen.findByRole('dialog', { name: 'Choose a demo persona' })).toBeInTheDocument();
    expect(screen.getByLabelText('current location')).toHaveTextContent('/login');
    expect(screen.getByText('Step 1 of 8')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('tour-target')).toHaveAttribute('data-tour-active', 'true'));
    expect(screen.getByRole('button', { name: 'Continue as Alex Seller' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByLabelText('current location')).toHaveTextContent('/login');
    expect(screen.getByText('Step 1 of 8')).toBeInTheDocument();
  });

  it('resets saved progress when the launcher is opened', async () => {
    window.localStorage.setItem('slacato.guided-tour.v1', JSON.stringify({ active: false, stepIndex: 4 }));
    render(createElement(TourHarness));

    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    await waitFor(() => expect(screen.getByLabelText('current location')).toHaveTextContent('/login'));
    expect(window.localStorage.getItem('slacato.guided-tour.v1')).toBe(JSON.stringify({ active: true, stepIndex: 0 }));
    expect(screen.getByText('Step 1 of 8')).toBeInTheDocument();
  });

  it('resumes on Deals at step two after login advances the persisted tour', async () => {
    window.localStorage.setItem('slacato.guided-tour.v1', JSON.stringify({ active: true, stepIndex: 0 }));

    expect(advanceGuidedTourFromLogin()).toBe(true);
    expect(window.localStorage.getItem('slacato.guided-tour.v1')).toBe(JSON.stringify({ active: true, stepIndex: 1 }));

    render(createElement(TourHarness, { initialPath: '/deals', target: 'nav-deals' }));

    expect(await screen.findByText('Step 2 of 8')).toBeInTheDocument();
    expect(screen.getByLabelText('current location')).toHaveTextContent('/deals');
    await waitFor(() => expect(screen.getByTestId('tour-target')).toHaveAttribute('data-tour-active', 'true'));
  });

  it('renders the launcher on login and advances the tour when a persona is selected', async () => {
    render(createElement(LoginHarness));
    const personaButton = await screen.findByRole('button', { name: 'Continue as Alex Seller' });

    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));
    expect(await screen.findByRole('dialog', { name: 'Choose a demo persona' })).toBeInTheDocument();
    fireEvent.click(personaButton);

    await waitFor(() => expect(screen.getByLabelText('current location')).toHaveTextContent('/deals'));
    expect(window.localStorage.getItem('slacato.guided-tour.v1')).toBe(JSON.stringify({ active: true, stepIndex: 1 }));
  });

  it('keeps dismissal controls available while a required target is missing', async () => {
    render(createElement(TourHarness, { withTarget: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    expect(await screen.findByText('The persona choices are not available yet. Wait for them to finish loading.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip tour' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Close guided tour' })).toBeInTheDocument();
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
      expect(screen.queryByText('The persona choices are not available yet. Wait for them to finish loading.')).not.toBeInTheDocument();
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
    expect(window.localStorage.getItem('slacato.guided-tour.v1')).toContain('"active":false');
  });

  it('traps keyboard focus on later steps and restores it to the launcher', async () => {
    window.localStorage.setItem('slacato.guided-tour.v1', JSON.stringify({ active: true, stepIndex: 1 }));
    render(createElement(TourHarness, { initialPath: '/deals', target: 'nav-deals' }));
    const launcher = screen.getByRole('button', { name: 'Start guided tour' });
    const next = await screen.findByRole('button', { name: 'Next' });
    expect(next).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close guided tour' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(launcher).toHaveFocus());
  });
});
