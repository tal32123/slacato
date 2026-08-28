import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { Persona } from '@slacato/contracts';
import { ArrowRight, Check, Database, LoaderCircle, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { listPersonas, getCsrf, selectPersona } from '@/api/auth';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

const roleDescriptions: Readonly<Record<string, string>> = {
  'Account Owner': 'Work the accounts assigned to this seller and request deal support.',
  'Restricted Account Owner': 'Work the assigned restricted account with sensitive access.',
  'Sales Leader': 'Review the sales team’s permitted accounts and active deal work.',
  'Deal Desk Approver': 'Review commercial decisions across assigned accounts.',
  'Unauthorized Requester': 'Demonstrate default-deny behavior for restricted work.'
};

type LoginState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; personas: readonly Persona[]; csrfToken: string }>
  | Readonly<{ status: 'error' }>;

export function LoginRoute(): React.JSX.Element {
  const [state, setState] = useState<LoginState>({ status: 'loading' });
  const [submitting, setSubmitting] = useState<string>();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([listPersonas(abort.signal), getCsrf(abort.signal)])
      .then(([personas, csrfToken]) => setState({ status: 'ready', personas, csrfToken }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setState({ status: 'error' });
      });
    return () => abort.abort();
  }, []);

  const choose = async (persona: Persona): Promise<void> => {
    if (state.status !== 'ready') return;
    setSubmitting(persona.userId);
    try {
      await selectPersona(persona.userId, state.csrfToken);
      await navigate(safeDestination(new URLSearchParams(location.search).get('returnTo')),
        { replace: true });
    } catch {
      setSubmitting(undefined);
      setState({ status: 'error' });
    }
  };

  return (
    <main className="min-h-screen bg-background lg:grid lg:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]">
      <aside className="relative overflow-hidden bg-[#182D2A] px-6 py-8 text-[#DEF6EF] sm:px-10 lg:flex lg:min-h-screen lg:flex-col lg:justify-between lg:px-12 lg:py-12">
        <div aria-hidden="true" className="absolute -right-24 top-20 size-64 rounded-full border border-[#81E5AC]/20" />
        <div aria-hidden="true" className="absolute -right-8 top-36 size-40 rounded-full border border-[#81E5AC]/15" />
        <div className="relative">
          <div className="mb-14 flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-[#81E5AC] text-[#182D2A]"><ShieldCheck className="size-6" /></span>
            <span className="text-xl font-semibold tracking-tight">SlaCato</span>
          </div>
          <Badge className="mb-5 border border-[#81E5AC]/35 bg-[#0D483D] text-[#81E5AC]">Verified demo workspace</Badge>
          <h1 className="max-w-lg text-3xl font-semibold leading-tight tracking-[-0.035em] sm:text-4xl lg:text-5xl">
            Deal intelligence with permission boundaries you can see.
          </h1>
          <p className="mt-5 max-w-md text-sm leading-6 text-[#DEF6EF]/75 sm:text-base">
            Step into a canonical sales persona to explore grounded account strategy, approvals, and evidence.
          </p>
        </div>
        <ul className="relative mt-10 grid gap-3 text-sm text-[#DEF6EF]/80 sm:grid-cols-3 lg:mt-16 lg:grid-cols-1">
          <TrustItem icon={Database} label="Canonical fixture identities" />
          <TrustItem icon={LockKeyhole} label="Server-authorized access" />
          <TrustItem icon={Sparkles} label="Deterministic demo ready" />
        </ul>
      </aside>

      <section className="mx-auto flex w-full max-w-5xl flex-col px-5 py-10 sm:px-10 sm:py-14 lg:justify-center lg:px-14">
        <div className="mb-8 max-w-2xl">
          <p className="mb-2 text-sm font-medium text-[#158864]">Demo access</p>
          <h2 className="text-3xl font-semibold tracking-[-0.025em] text-foreground sm:text-4xl">Choose your demo persona</h2>
          <p className="mt-3 leading-6 text-muted-foreground">No passwords. No invented roles. Every option comes from the ingested permissions fixture.</p>
        </div>

        {state.status === 'loading' && <LoadingState />}
        {state.status === 'error' && (
          <Alert variant="destructive">
            <AlertTitle>Demo access is temporarily unavailable</AlertTitle>
            <AlertDescription>Check that the API and canonical fixture ingestion are ready, then refresh this page.</AlertDescription>
          </Alert>
        )}
        {state.status === 'ready' && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {state.personas.map((persona) => (
              <Card key={persona.userId} className="gap-4 border-border/90 py-5 transition-[border-color,box-shadow] hover:border-[#158864]/60 hover:shadow-md">
                <CardHeader className="px-5">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <span className="grid size-11 place-items-center rounded-full bg-[#DEF6EF] text-sm font-semibold text-[#0D483D]">
                      {initials(persona.displayName)}
                    </span>
                    {persona.role === 'Deal Desk Approver' && <Badge className="bg-[#F5C13D]/25 text-[#5b4300]">Approver</Badge>}
                  </div>
                  <CardTitle className="text-lg"><h3>{persona.displayName}</h3></CardTitle>
                  <CardDescription className="font-medium text-[#0D483D]">{persona.role}</CardDescription>
                </CardHeader>
                <CardContent className="min-h-14 px-5 text-sm leading-5 text-muted-foreground">
                  {roleDescriptions[persona.role] ?? 'Use the canonical permissions assigned to this demo identity.'}
                </CardContent>
                <CardFooter className="px-5">
                  <Button className="w-full justify-between" disabled={submitting !== undefined} onClick={() => void choose(persona)}>
                    <span>{submitting === persona.userId ? 'Opening workspace…' : `Continue as ${persona.displayName}`}</span>
                    {submitting === persona.userId ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
        <p className="mt-7 flex items-center gap-2 text-xs text-muted-foreground"><Check className="size-4 text-[#158864]" /> Sessions expire automatically after eight hours.</p>
      </section>
    </main>
  );
}

function TrustItem({ icon: Icon, label }: Readonly<{ icon: typeof Database; label: string }>): React.JSX.Element {
  return <li className="flex items-center gap-3"><Icon className="size-4 text-[#81E5AC]" /><span>{label}</span></li>;
}

function LoadingState(): React.JSX.Element {
  return <div className="grid min-h-52 place-items-center rounded-xl border bg-card"><div className="flex items-center gap-3 text-sm text-muted-foreground"><LoaderCircle className="animate-spin text-[#158864]" />Loading canonical personas…</div></div>;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function safeDestination(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}
