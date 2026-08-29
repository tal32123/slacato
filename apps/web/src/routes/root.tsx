import type { LoaderFunctionArgs } from 'react-router';
import type { DemoSession } from '@slacato/contracts';
import { ArrowRight, CircleCheckBig, ListTodo, ShieldCheck } from 'lucide-react';
import { Link, redirect, useLoaderData, useNavigate, useRouteLoaderData } from 'react-router';
import { queryClient, csrfQueryOptions, logoutSession, safeDestination, sessionQueryOptions } from '@/api/session';
import { AppShell } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';

export async function protectedRootLoader({ request }: LoaderFunctionArgs): Promise<DemoSession | Response> {
  const session = await queryClient.ensureQueryData(sessionQueryOptions());
  if (!session.authenticated) {
    const url = new URL(request.url);
    const returnTo = safeDestination(`${url.pathname}${url.search}`, '/deals');
    return redirect(`/unauthorized?returnTo=${encodeURIComponent(returnTo)}`);
  }
  return session;
}

export function RootRoute(): React.JSX.Element {
  const session = useLoaderData() as DemoSession;
  const navigate = useNavigate();

  const logOut = async (): Promise<void> => {
    const csrfToken = await queryClient.ensureQueryData(csrfQueryOptions(session.version));
    await logoutSession(csrfToken);
    await navigate('/login', { replace: true });
  };

  return <AppShell session={session} onLogout={logOut} />;
}

export function DealsHomeRoute(): React.JSX.Element {
  const session = useProtectedSession();
  return (
    <div className="grid gap-8">
      <header className="max-w-3xl">
        <p className="text-sm font-medium text-primary">Authorized deal preparation</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Welcome, {firstName(session.persona.displayName)}</h1>
        <p className="mt-4 text-base leading-7 text-muted-foreground">
          SlaCato helps sellers prepare for negotiations with internal, evidence-backed suggestions grounded in the sources their persona may access.
        </p>
      </header>
      <section className="grid gap-5 border-y py-7 sm:grid-cols-[minmax(0,1fr)_minmax(16rem,0.55fr)]" aria-labelledby="assistant-boundary-title">
        <div>
          <h2 id="assistant-boundary-title" className="text-xl font-semibold">Seller judgment stays in control</h2>
          <p className="mt-2 max-w-2xl leading-6 text-muted-foreground">
            Recommendations prepare the internal team; they do not negotiate or send customer-facing content. Account owners and required reviewers decide what happens next.
          </p>
        </div>
        <div className="flex items-start gap-3 rounded-lg bg-secondary p-4 text-secondary-foreground">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p className="text-sm leading-6">Every protected view is reauthorized for <strong>{session.persona.role}</strong>.</p>
        </div>
      </section>
      <div className="flex flex-wrap gap-3">
        <Button asChild className="min-h-11"><Link to="/runs">Review brief runs<ArrowRight aria-hidden="true" /></Link></Button>
        <Button asChild variant="outline" className="min-h-11"><Link to="/settings">Change persona</Link></Button>
      </div>
    </div>
  );
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

function useProtectedSession(): DemoSession {
  const session = useRouteLoaderData('protected-root') as DemoSession | undefined;
  if (session === undefined) throw new Error('Protected session was not loaded');
  return session;
}

function firstName(displayName: string): string {
  return displayName.split(/\s+/)[0] ?? displayName;
}
