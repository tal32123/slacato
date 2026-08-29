// @vitest-environment jsdom

import { createElement } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuidedTour } from '../../apps/web/src/components/guided-tour';

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return createElement('output', { 'aria-label': 'current location' }, location.pathname);
}

function TourHarness({ withTarget = true }: Readonly<{ withTarget?: boolean }>): React.JSX.Element {
  return createElement(
    MemoryRouter,
    { initialEntries: ['/settings'] },
    withTarget ? createElement('button', { 'data-tour': 'persona' }, 'Persona menu') : null,
    createElement('main', { id: 'main-content' }),
    createElement(GuidedTour),
    createElement(LocationProbe)
  );
}

describe('GuidedTour', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it('opens an accessible spotlight on the first real control', async () => {
    render(createElement(TourHarness));

    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    expect(await screen.findByRole('dialog', { name: 'Choose the active persona' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 8')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Persona menu' })).toHaveAttribute('data-tour-active', 'true'));
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
  });

  it('persists progress and navigates to the next step without activating page controls', async () => {
    render(createElement(TourHarness));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByLabelText('current location')).toHaveTextContent('/deals'));
    expect(window.localStorage.getItem('slacato.guided-tour.v1')).toContain('"stepIndex":1');
    expect(screen.getByText('Step 2 of 8')).toBeInTheDocument();
  });

  it('keeps controls available when a route target is missing', async () => {
    render(createElement(TourHarness, { withTarget: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));

    expect(await screen.findByText('This item is not available in the current view. You can continue safely.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Close guided tour' })).toBeInTheDocument();
  });

  it('does not show a stale missing-target warning when routed content arrives', async () => {
    render(createElement(TourHarness, { withTarget: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const target = document.createElement('button');
    target.dataset.tour = 'persona';
    target.textContent = 'Delayed persona menu';
    document.getElementById('main-content')!.append(target);

    await waitFor(() => expect(target).toHaveAttribute('data-tour-active', 'true'));
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(screen.queryByText('This item is not available in the current view. You can continue safely.')).not.toBeInTheDocument();
  });

  it('closes on Escape and saves an inactive resumable state', async () => {
    render(createElement(TourHarness));
    fireEvent.click(screen.getByRole('button', { name: 'Start guided tour' }));
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.localStorage.getItem('slacato.guided-tour.v1')).toContain('"active":false');
  });

  it('traps keyboard focus inside the coachmark and restores it to the launcher', async () => {
    render(createElement(TourHarness));
    const launcher = screen.getByRole('button', { name: 'Start guided tour' });
    fireEvent.click(launcher);
    const next = await screen.findByRole('button', { name: 'Next' });
    expect(next).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close guided tour' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(launcher).toHaveFocus());
  });
});
