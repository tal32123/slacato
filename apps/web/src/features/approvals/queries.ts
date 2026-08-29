import { queryOptions } from '@tanstack/react-query';
import { fetchApprovalDetail, fetchApprovals } from '@/api/client';
import { queryKeys, sessionRuntime, SessionInvalidatedError } from '@/api/session';

export const approvalsQueryOptions = (version: string) => scopedQuery(
  version,
  'approvals',
  (signal) => fetchApprovals(signal)
);

export const approvalDetailQueryOptions = (version: string, subjectId: string) => scopedQuery(
  version,
  `approval:${subjectId}`,
  (signal) => fetchApprovalDetail(subjectId, signal)
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
