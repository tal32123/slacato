// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from '../../apps/web/src/components/app-error-boundary';

function BrokenView(): React.JSX.Element {
  throw new Error('render failed');
}

describe('AppErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('replaces an uncaught React render failure with a recoverable alert', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AppErrorBoundary>
        <BrokenView />
      </AppErrorBoundary>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The application could not be loaded');
    expect(screen.getByRole('button', { name: 'Reload application' })).toBeInTheDocument();
  });
});
