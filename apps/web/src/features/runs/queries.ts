import { queryOptions } from '@tanstack/react-query';
import { fetchRunDetail, fetchRuns } from '@/api/client';
import { queryKeys, SessionInvalidatedError, sessionRuntime } from '@/api/session';

/** Defines session-aware loading for the run history visible to the active persona. */
export const runsQueryOptions = (version: string) =>
  scopedQuery(version, 'runs', (signal) => fetchRuns(signal));

/** Defines session-aware loading for a selected run's latest detail. */
export const runDetailQueryOptions = (version: string, runId: string) =>
  scopedQuery(version, `run:${runId}`, (signal) => fetchRunDetail(runId, signal));

/** Builds a protected query that rejects responses from an outdated session. */
function scopedQuery<T>(
  version: string,
  resource: string,
  query: (signal: AbortSignal) => Promise<T & { sessionVersion: string }>
) {
  const generation = sessionRuntime.generation;
  const queryKey = queryKeys.scoped(version, resource);
  return queryOptions({
    queryKey,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await query(signal);
      if (response.sessionVersion !== version || !sessionRuntime.accepts(generation)) {
        await sessionRuntime.reconcileAuthoritativeSession(queryKey);
        throw new SessionInvalidatedError();
      }
      return response;
    }
  });
}
