import { queryOptions } from '@tanstack/react-query';
import { fetchRunDetail, fetchRuns } from '@/api/client';
import { queryKeys, sessionRuntime, SessionInvalidatedError } from '@/api/session';

export const runsQueryOptions = (version: string) => scopedQuery(
  version,
  'runs',
  (signal) => fetchRuns(signal)
);

export const runDetailQueryOptions = (version: string, runId: string) => scopedQuery(
  version,
  `run:${runId}`,
  (signal) => fetchRunDetail(runId, signal)
);

function scopedQuery<T>(version: string, resource: string, query: (signal: AbortSignal) => Promise<T & { sessionVersion: string }>) {
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
