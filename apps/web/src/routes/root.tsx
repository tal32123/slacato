import { useSyncExternalStore } from 'react';
import type { LoaderFunctionArgs } from 'react-router';
import type { DemoSession } from '@slacato/contracts';
import { redirect, useLoaderData, useNavigate } from 'react-router';
import { queryClient, csrfQueryOptions, logoutSession, safeDestination, sessionQueryOptions, sessionRuntime } from '@/api/session';
import { AppShell } from '@/components/app-shell';
import { throwProtectedLoaderError } from './loader-security';
import { RoutePending } from './route-pending';

export async function protectedRootLoader({ request }: LoaderFunctionArgs): Promise<DemoSession | Response> {
  try {
    const session = await queryClient.fetchQuery(sessionQueryOptions());
    if (!session.authenticated) {
      sessionRuntime.finishTransition();
      const url = new URL(request.url);
      const returnTo = safeDestination(`${url.pathname}${url.search}`, '/deals');
      return redirect(`/unauthorized?returnTo=${encodeURIComponent(returnTo)}`);
    }
    sessionRuntime.finishTransition();
    return session;
  } catch (error) {
    throwProtectedLoaderError(error, request);
  }
}

export function RootRoute(): React.JSX.Element {
  const session = useLoaderData() as DemoSession;
  const navigate = useNavigate();
  const transitioning = useSyncExternalStore(
    (listener) => sessionRuntime.subscribe(listener),
    () => sessionRuntime.transitioning
  );

  const logOut = async (): Promise<void> => {
    const csrfToken = await queryClient.ensureQueryData(csrfQueryOptions(session.version));
    await logoutSession(csrfToken);
    await navigate('/login', { replace: true });
    sessionRuntime.finishTransition();
  };

  if (transitioning) return <RoutePending />;
  return <AppShell session={session} onLogout={logOut} />;
}

