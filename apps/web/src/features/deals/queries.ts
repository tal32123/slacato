import { queryOptions } from '@tanstack/react-query';
import { fetchDeals, fetchDealWorkspace } from '@/api/client';
import { queryKeys, sessionRuntime, SessionInvalidatedError } from '@/api/session';

export const dealsQueryOptions = (version: string) => {
  const generation = sessionRuntime.generation;
  const queryKey = queryKeys.scoped(version, 'deals');
  return queryOptions({
    queryKey,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetchDeals(signal);
      if (response.sessionVersion !== version || !sessionRuntime.accepts(generation)) {
        await sessionRuntime.reconcileAuthoritativeSession(queryKey);
        throw new SessionInvalidatedError();
      }
      return response;
    }
  });
};

export const dealWorkspaceQueryOptions = (version: string, opportunityId: string) => {
  const generation = sessionRuntime.generation;
  const queryKey = queryKeys.scoped(version, `deal:${opportunityId}`);
  return queryOptions({
    queryKey,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetchDealWorkspace(opportunityId, signal);
      if (response.sessionVersion !== version || !sessionRuntime.accepts(generation)) {
        await sessionRuntime.reconcileAuthoritativeSession(queryKey);
        throw new SessionInvalidatedError();
      }
      return response;
    }
  });
};
