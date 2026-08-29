import { useSyncExternalStore } from 'react';
import type { LoaderFunctionArgs } from 'react-router';
import type { DemoSession } from '@slacato/contracts';
import { CircleCheckBig, ListTodo } from 'lucide-react';
import { redirect, useLoaderData, useNavigate } from 'react-router';
import { queryClient, csrfQueryOptions, logoutSession, safeDestination, sessionQueryOptions, sessionRuntime } from '@/api/session';
import { AppShell } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';
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


export function RunsHomeRoute(): React.JSX.Element {
  return (
    <section className="max-w-3xl" aria-labelledby="runs-title">
      <StatusBadge status="readonly" label="Persona-scoped" />
      <h1 id="runs-title" className="mt-4 text-3xl font-semibold tracking-tight">Runs</h1>
      <p className="mt-3 leading-7 text-muted-foreground">
        Durable brief runs keep workflow progress, review requirements, and validated outputs tied to the identity that started them. Viewing a run always requires current authorization.
      </p>
      <div className="mt-7 flex items-start gap-3 border-t pt-6">
        <ListTodo aria-hidden="true" className="mt-0.5 size-5 text-primary" />
        <p className="text-sm leading-6">Open a stable run URL from an authorized deal to rejoin its persisted progress.</p>
      </div>
    </section>
  );
}

export function ApprovalsHomeRoute(): React.JSX.Element {
  return (
    <section className="max-w-3xl" aria-labelledby="approvals-title">
      <StatusBadge status="readonly" label="Authority-scoped" />
      <h1 id="approvals-title" className="mt-4 text-3xl font-semibold tracking-tight">Approvals</h1>
      <p className="mt-3 leading-7 text-muted-foreground">
        Request permission and decision authority remain separate. Commercial, leadership, legal, and account-owner decisions are shown only to personas with the required scoped authority.
      </p>
      <div className="mt-7 flex items-start gap-3 border-t pt-6">
        <CircleCheckBig aria-hidden="true" className="mt-0.5 size-5 text-primary" />
        <p className="text-sm leading-6">Review your exact authority and canonical grants in Demo Diagnostics.</p>
      </div>
    </section>
  );
}

