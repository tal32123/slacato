import type { DemoSession } from '@slacato/contracts';
import { useQuery } from '@tanstack/react-query';
import { BookOpenCheck, Check, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LoaderFunctionArgs } from 'react-router';
import { Link, useNavigate, useRevalidator, useRouteLoaderData } from 'react-router';
import {
  csrfQueryOptions,
  logoutSession,
  personasQueryOptions,
  queryClient,
  selectPersonaSession,
  sessionQueryOptions
} from '@/api/session';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { throwProtectedLoaderError } from './loader-security';

/** Preloads the persona and security data needed to manage the current demo session. */
export async function settingsLoader({ request }: LoaderFunctionArgs): Promise<null> {
  try {
    const session = await queryClient.fetchQuery(sessionQueryOptions());
    if (session.authenticated) {
      await Promise.all([
        queryClient.ensureQueryData(personasQueryOptions()),
        queryClient.ensureQueryData(csrfQueryOptions(session.version))
      ]);
    }
    return null;
  } catch (error) {
    throwProtectedLoaderError(error, request);
  }
}

/** Lets users inspect their persona and switch the active demo identity safely. */
export function SettingsRoute(): React.JSX.Element {
  const session = useProtectedSession();
  const personas = useQuery(personasQueryOptions());
  const csrf = useQuery(csrfQueryOptions(session.version));
  const [selected, setSelected] = useState(session.persona.userId);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState(false);
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  useEffect(() => setSelected(session.persona.userId), [session.persona.userId]);

  const changePersona = async (): Promise<void> => {
    if (selected === session.persona.userId || csrf.data === undefined) return;
    setSaving(true);
    setMutationError(false);
    try {
      await selectPersonaSession(selected, csrf.data);
      await revalidator.revalidate();
    } catch {
      setMutationError(true);
    } finally {
      setSaving(false);
    }
  };

  const logOut = async (): Promise<void> => {
    if (csrf.data === undefined) return;
    setSaving(true);
    try {
      await logoutSession(csrf.data);
      await navigate('/login', { replace: true });
    } catch {
      setMutationError(true);
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-8">
      <header className="max-w-3xl">
        <p className="text-sm font-medium text-primary">Settings</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Persona &amp; session</h1>
        <p className="mt-3 leading-6 text-muted-foreground">
          Choose a canonical demo identity. The server signs each session and reauthorizes every
          protected request.
        </p>
      </header>

      <Card className="border-primary/30 bg-primary/5 shadow-none">
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
              <BookOpenCheck aria-hidden="true" />
            </span>
            <div>
              <CardTitle>New here? Follow the home-task walkthrough</CardTitle>
              <CardDescription className="mt-2 leading-6">
                See how each Cato assignment requirement maps to a persona, screen, action, and
                inspectable result.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Button asChild className="min-h-11">
            <Link to="/walkthrough">Start walkthrough</Link>
          </Button>
        </CardContent>
      </Card>

      {mutationError && (
        <Alert variant="destructive">
          <AlertTitle>Session change could not be completed</AlertTitle>
          <AlertDescription>Your previous session remains active. Try again.</AlertDescription>
        </Alert>
      )}

      <section aria-labelledby="persona-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="persona-heading" className="text-xl font-semibold">
              Active persona
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Changing persona closes open views and live connections before protected data is
              reloaded.
            </p>
          </div>
          <Button
            className="min-h-11"
            disabled={saving || selected === session.persona.userId || csrf.data === undefined}
            onClick={() => void changePersona()}
          >
            {saving ? 'Changing persona…' : 'Use selected persona'}
          </Button>
        </div>

        <fieldset className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <legend className="sr-only">Canonical demo personas</legend>
          {personas.data?.map((persona) => {
            const active = persona.userId === session.persona.userId;
            return (
              <label
                key={persona.userId}
                className={cn(
                  'relative flex min-h-20 cursor-pointer items-start gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary/50',
                  selected === persona.userId && 'border-primary ring-2 ring-ring/20'
                )}
              >
                <input
                  type="radio"
                  name="persona"
                  value={persona.userId}
                  checked={selected === persona.userId}
                  onChange={() => setSelected(persona.userId)}
                  className="mt-1 size-5 accent-primary"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 font-medium">
                    {persona.displayName}
                    {active && <Check aria-hidden="true" className="size-4 text-primary" />}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">{persona.role}</span>
                  {active && <span className="sr-only">{persona.displayName}, active persona</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
      </section>

      <section className="grid gap-4 border-t pt-7 lg:grid-cols-2" aria-label="Session controls">
        <Card className="gap-4 shadow-none">
          <CardHeader>
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-md bg-secondary text-secondary-foreground">
                <LockKeyhole aria-hidden="true" />
              </span>
              <div>
                <CardTitle>Signed demo session</CardTitle>
                <CardDescription>HTTP-only identity cookie with CSRF protection</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Persona</dt>
              <dd>{session.persona.displayName}</dd>
              <dt className="text-muted-foreground">Role</dt>
              <dd>{session.persona.role}</dd>
              <dt className="text-muted-foreground">Duration</dt>
              <dd>Up to eight hours</dd>
            </dl>
            <Button
              className="mt-5 min-h-11"
              variant="outline"
              disabled={saving || csrf.data === undefined}
              onClick={() => void logOut()}
            >
              Log out
            </Button>
          </CardContent>
        </Card>

        <Card className="gap-4 shadow-none">
          <CardHeader>
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-md bg-secondary text-secondary-foreground">
                <ShieldCheck aria-hidden="true" />
              </span>
              <div>
                <CardTitle>Demo Diagnostics</CardTitle>
                <CardDescription>Secondary, read-only implementation facts</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-6 text-muted-foreground">
              Inspect the canonical grants and runtime configuration attached to this signed
              persona.
            </p>
            <Button asChild className="mt-5 min-h-11" variant="outline">
              <Link to="/diagnostics">Demo Diagnostics</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

/** Provides the authenticated session required by the settings experience. */
function useProtectedSession(): DemoSession {
  const session = useRouteLoaderData('protected-root') as DemoSession | undefined;
  if (session === undefined) throw new Error('Protected session was not loaded');
  return session;
}
