import { redirect } from 'react-router';
import { ApiError } from '@/api/client';
import {
  queryClient,
  queryKeys,
  safeDestination,
  sessionRuntime,
  SessionInvalidatedError
} from '@/api/session';

export function throwProtectedLoaderError(error: unknown, request: Request): never {
  const url = new URL(request.url);
  const returnTo = safeDestination(`${url.pathname}${url.search}`);

  if (error instanceof SessionInvalidatedError) {
    throw redirect(returnTo);
  }
  if (error instanceof ApiError && error.status === 401) {
    sessionRuntime.prepareTransition();
    queryClient.removeQueries({ queryKey: queryKeys.session });
    sessionRuntime.broadcast('invalidate');
    throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (error instanceof ApiError && error.status === 403) {
    throw redirect('/forbidden');
  }
  throw error;
}
