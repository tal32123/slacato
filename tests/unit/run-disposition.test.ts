// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBrief } from '../../apps/web/src/api/client';

/**
 * Answers a Generate Brief request the way the API does: 201, the strict `{ runId }` body, and the
 * disposition carried only in a header, because `startBriefResponseSchema` is `.strict()` and
 * cannot hold the field.
 */
function respondWith(disposition: string | undefined): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ runId: 'run-1' }), {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
            ...(disposition === undefined ? {} : { 'X-Run-Disposition': disposition })
          }
        })
      )
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Generate Brief reports what the server actually did', () => {
  // A request that lands on an already-active run is answered with the same status and the same
  // body as one that starts fresh work. Without reading the header the interface cannot tell the
  // two apart, and a reviewer who presses Generate Brief is silently shown someone else's run.
  it.each(['created', 'joined', 'replayed'] as const)('reports a "%s" run', async (disposition) => {
    respondWith(disposition);

    await expect(startBrief({ opportunityId: 'OPP-1001', idempotencyKey: '3f6c6f4e-1f8a-4a1e-9a6d-9a1b2c3d4e5f' }, 'csrf-token')).resolves.toEqual({
      runId: 'run-1',
      disposition
    });
  });

  it.each([undefined, 'something-new'])(
    'reports nothing rather than guessing when the header reads %s',
    async (header) => {
      respondWith(header);

      const started = await startBrief({ opportunityId: 'OPP-1001', idempotencyKey: '3f6c6f4e-1f8a-4a1e-9a6d-9a1b2c3d4e5f' }, 'csrf-token');

      expect(started.runId).toBe('run-1');
      expect(started.disposition).toBeUndefined();
    }
  );
});
