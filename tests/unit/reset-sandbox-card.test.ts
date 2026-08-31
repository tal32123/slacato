// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import '@testing-library/jest-dom/vitest';
import type { SandboxResetReportView } from '@slacato/contracts';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../apps/web/src/api/session';
import { ResetSandboxCard } from '../../apps/web/src/features/sandbox/reset-sandbox-card';

const fetchSandboxResetMock = vi.fn<() => Promise<SandboxResetReportView>>();
const resetSandboxMock = vi.fn<() => Promise<SandboxResetReportView>>();

vi.mock('@/api/client', () => ({
  fetchSandboxReset: () => fetchSandboxResetMock(),
  fetchCsrf: () => Promise.resolve('csrf-token'),
  resetSandbox: () => resetSandboxMock()
}));

const report: SandboxResetReportView = {
  database: 'slacato_demo',
  tally: {
    runs: 3,
    runsInFlight: 0,
    approvalSubjects: 5,
    approvalDecisions: 4,
    briefs: 3,
    runEvents: 41,
    traceSpans: 12,
    queuedCommands: 0,
    auditEvents: 7
  },
  retained: { evidenceVersions: 137, opportunities: 3, personas: 8 }
};

/** Mounts the card with a fresh query cache for one session version. */
function mount(sessionVersion: string) {
  queryClient.clear();
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ResetSandboxCard, { sessionVersion })
    )
  );
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.clearAllMocks();
});

describe('Reset sandbox control', () => {
  it('renders nothing at all where the capability does not answer', async () => {
    // A deployment that was never designated a sandbox, and a persona without standing to clear
    // one, both arrive here as a failed request. Neither may leave a disabled destructive control
    // on the page: that would advertise the capability and invite attempts to reach it.
    fetchSandboxResetMock.mockRejectedValue(new Error('not found'));
    const { container } = mount('version-absent');
    await waitFor(() => expect(fetchSandboxResetMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: /reset sandbox/i })).toBeNull();
  });

  it('never flashes into view while the capability is still being decided', () => {
    fetchSandboxResetMock.mockReturnValue(new Promise(() => undefined));
    const { container } = mount('version-pending');
    expect(container).toBeEmptyDOMElement();
  });

  it('states the counts and the boundary before asking for confirmation', async () => {
    fetchSandboxResetMock.mockResolvedValue(report);
    mount('version-enabled');
    await screen.findByRole('button', { name: /reset sandbox/i });
    expect(screen.getByText(/slacato_demo/)).toBeInTheDocument();
    // Both halves of the boundary are on the page: what goes, and what deliberately stays.
    expect(screen.getByText(/Erases everything the demo produced/)).toBeInTheDocument();
    expect(screen.getByText(/Keeps everything that was ingested/)).toBeInTheDocument();
    expect(screen.getByText('approval requests')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(resetSandboxMock).not.toHaveBeenCalled();
  });
});
