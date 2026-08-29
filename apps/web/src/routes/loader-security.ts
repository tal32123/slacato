import { redirect } from 'react-router';
import { ApiError } from '@/api/client';
import {
  queryClient,
  queryKeys,
  safeDestination,
  sessionRuntime,
  SessionInvalidatedError
} from '@/api/session';

/** Converts protected-loader failures into safe reauthentication, denial, or retry responses. */
export function throwProtectedLoaderError(error: unknown, request: Request): never {
  if (error instanceof SessionInvalidatedError) {
    sessionRuntime.finishTransition();
    throw new Response('Protected data changed repeatedly while loading.', {
      status: 409,
      statusText: 'Protected data changed'
    });
  }
  const url = new URL(request.url);
  const returnTo = safeDestination(`${url.pathname}${url.search}`);
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
