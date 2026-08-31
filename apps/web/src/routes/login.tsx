import type { Persona } from '@slacato/contracts';
import { Check, Database, LoaderCircle, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { fetchCsrf, fetchPersonas } from '@/api/client';
import { safeDestination, selectPersonaSession, sessionRuntime } from '@/api/session';
import {
  advanceGuidedTourFromLogin,
  GuidedTour,
  GuidedTourInvitation
} from '@/components/guided-tour';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { demoPersonaPurpose, groupDemoPersonas } from '@/features/personas/demo-personas';

type LoginState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; personas: readonly Persona[]; csrfToken: string }>
  | Readonly<{ status: 'error' }>;

/** Presents persona-based sign-in choices and guides the user into the protected workspace. */
export function LoginRoute(): React.JSX.Element {
  const [state, setState] = useState<LoginState>({ status: 'loading' });
  const [submitting, setSubmitting] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    sessionRuntime.finishTransition();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry changes must reload personas and CSRF.
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([fetchPersonas(abort.signal), fetchCsrf(abort.signal)])
      .then(([personas, csrfToken]) => setState({ status: 'ready', personas, csrfToken }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          setState({ status: 'error' });
      });
    return () => abort.abort();
  }, [loadAttempt]);

  const retry = (): void => {
    setState({ status: 'loading' });
    setLoadAttempt((attempt) => attempt + 1);
  };

  const choose = async (persona: Persona): Promise<void> => {
    if (state.status !== 'ready') return;
    setSubmitting(persona.userId);
    try {
      await selectPersonaSession(persona.userId, state.csrfToken);
      const continueGuidedTour = advanceGuidedTourFromLogin();
      const destination = continueGuidedTour
        ? '/deals'
        : safeDestination(new URLSearchParams(location.search).get('returnTo'));
      await navigate(destination, { replace: true });
    } catch {
      setSubmitting(undefined);
      setState({ status: 'error' });
    }
  };

  return (
    <main
      id="main-content"
      className="min-h-screen bg-background lg:grid lg:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]"
    >
      <aside className="relative overflow-hidden bg-brand-forest px-6 py-8 text-brand-pale sm:px-10 lg:flex lg:min-h-screen lg:flex-col lg:justify-between lg:px-12 lg:py-12">
        <div className="relative">
          <div className="mb-14 flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-brand-mint text-brand-forest">
              <ShieldCheck className="size-6" />
            </span>
            <span className="text-xl font-semibold tracking-tight">SlaCato</span>
          </div>
          <Badge className="mb-5 border border-brand-mint/35 bg-brand-medium text-brand-mint">
            Verified demo workspace
          </Badge>
          <h1 className="max-w-lg text-3xl font-semibold leading-tight tracking-tight sm:text-4xl lg:text-5xl">
            Deal intelligence with permission boundaries you can see.
          </h1>
          <p className="mt-5 max-w-md text-sm leading-6 text-brand-pale/75 sm:text-base">
            Step into a canonical sales persona to explore grounded account strategy, approvals, and
            evidence.
          </p>
        </div>
        <ul className="relative mt-10 grid gap-3 text-sm text-brand-pale/80 sm:grid-cols-3 lg:mt-16 lg:grid-cols-1">
          <TrustItem icon={Database} label="Canonical fixture identities" />
          <TrustItem icon={LockKeyhole} label="Server-authorized access" />
          <TrustItem icon={Sparkles} label="Deterministic demo ready" />
        </ul>
      </aside>

      <section className="mx-auto flex w-full max-w-5xl flex-col px-5 py-10 sm:px-10 sm:py-14 lg:justify-center lg:px-14">
        <div className="mb-8 max-w-2xl">
          <p className="mb-2 text-sm font-medium text-primary">Demo access</p>
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Choose your demo persona
          </h2>
          <p className="mt-3 leading-6 text-muted-foreground">
            No passwords. No invented roles. Every option comes from the ingested permissions
            fixture.
          </p>
        </div>

        <GuidedTourInvitation />

        {state.status === 'loading' && <LoadingState />}
        {state.status === 'error' && (
          <Alert variant="destructive">
            <AlertTitle>Demo access is temporarily unavailable</AlertTitle>
            <AlertDescription>
              Check that the API and canonical fixture ingestion are ready, then try again.
            </AlertDescription>
            <Button className="mt-4 min-h-11" variant="outline" onClick={retry}>
              Try again
            </Button>
          </Alert>
        )}
        {state.status === 'ready' && (
          <div className="grid gap-8">
            {groupDemoPersonas(state.personas).map((group) => {
              const cards = (
                <div
                  data-tour={group.id === 'scenario' ? 'login-personas' : undefined}
                  className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
                >
                  {group.personas.map((persona) => (
                    <PersonaChoice
                      key={persona.userId}
                      persona={persona}
                      submitting={submitting}
                      onChoose={choose}
                    />
                  ))}
                </div>
              );
              if (group.collapsed)
                return (
                  <details key={group.id} className="rounded-xl border bg-card/60 px-5 py-4">
                    {/* Typography matches the open groups' <h3> so the three group titles read as
                        one level rather than the collapsed one looking like a footnote. */}
                    <summary className="min-h-11 cursor-pointer text-lg font-semibold tracking-tight marker:text-muted-foreground">
                      {group.title}
                    </summary>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                      {group.description}
                    </p>
                    <div className="mt-4">{cards}</div>
                  </details>
                );
              return (
                <section key={group.id} aria-labelledby={`persona-group-${group.id}`}>
                  <h3
                    id={`persona-group-${group.id}`}
                    className="text-lg font-semibold tracking-tight"
                  >
                    {group.title}
                  </h3>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                    {group.description}
                  </p>
                  <div className="mt-4">{cards}</div>
                </section>
              );
            })}
          </div>
        )}
        <p className="mt-7 flex items-center gap-2 text-xs text-muted-foreground">
          <Check className="size-4 text-primary" /> Sessions expire automatically after eight hours.
        </p>
      </section>
      <GuidedTour />
    </main>
  );
}

/** Presents one canonical identity, why the demo keeps it, and its sign-in control. */
function PersonaChoice({
  persona,
  submitting,
  onChoose
}: Readonly<{
  persona: Persona;
  submitting: string | undefined;
  onChoose: (persona: Persona) => Promise<void>;
}>): React.JSX.Element {
  // min-w-0 keeps the card inside its grid track: a grid item's automatic minimum size is its
  // min-content width, and the sign-in label used to make that wider than the column, which pushed
  // the cards past the viewport edge at 390px and past the card edge in the 3-column layout.
  // h-full plus flex-1 on the body makes every card fill its row and puts the slack above the
  // footer, so the primary action sits on one baseline whatever the description length.
  return (
    <Card className="h-full min-w-0 gap-4 border-border/90 py-5 transition-[border-color,box-shadow] hover:border-primary/60 hover:shadow-md">
      <CardHeader className="px-5">
        <div className="mb-2 flex items-start justify-between gap-3">
          <span className="grid size-11 place-items-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">
            {initials(persona.displayName)}
          </span>
          {persona.role === 'Deal Desk Approver' && (
            <Badge className="bg-attention/25 text-attention-foreground">Approver</Badge>
          )}
        </div>
        <CardTitle className="text-lg">
          <h4>{persona.displayName}</h4>
        </CardTitle>
        <CardDescription className="font-medium text-primary">{persona.role}</CardDescription>
      </CardHeader>
      <CardContent className="min-h-14 flex-1 px-5 text-sm leading-5 text-muted-foreground">
        {demoPersonaPurpose(persona)}
      </CardContent>
      <CardFooter className="px-5">
        {/* The label carries the persona name, so it is the widest thing in the card and it used to
            spill out of the button in the 3-column layout. Dropping the decorative arrow and the
            wide inline padding gives every canonical name a single line down to the narrowest
            3-column width; whitespace-normal keeps an unusually long fixture name wrapping inside
            the button instead of overflowing it. The label is centred, so the reduced inline padding
            is not visible. */}
        <Button
          className="h-auto min-h-11 w-full whitespace-normal px-2 py-2 text-center leading-5"
          disabled={submitting !== undefined}
          onClick={() => void onChoose(persona)}
        >
          {submitting === persona.userId && (
            <LoaderCircle aria-hidden="true" className="animate-spin" />
          )}
          <span>
            {submitting === persona.userId
              ? 'Opening workspace…'
              : `Continue as ${persona.displayName}`}
          </span>
        </Button>
      </CardFooter>
    </Card>
  );
}

/** Displays one trust statement about the product's data and access model. */
function TrustItem({
  icon: Icon,
  label
}: Readonly<{ icon: typeof Database; label: string }>): React.JSX.Element {
  return (
    <li className="flex items-center gap-3">
      <Icon className="size-4 text-brand-mint" />
      <span>{label}</span>
    </li>
  );
}

/** Shows a stable loading state while the available personas are retrieved. */
function LoadingState(): React.JSX.Element {
  return (
    <div className="grid min-h-52 place-items-center rounded-xl border bg-card">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <LoaderCircle className="animate-spin text-primary" />
        Loading canonical personas…
      </div>
    </div>
  );
}

/** Produces a compact avatar label from a person's name. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}
