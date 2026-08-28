import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import type { AuthSessionResponse } from '@slacato/contracts';
import { ArrowRight, LoaderCircle, ShieldCheck } from 'lucide-react';
import { getCsrf, getSession, logout } from '@/api/auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function WorkspaceRoute(): React.JSX.Element {
  const [session, setSession] = useState<AuthSessionResponse>();
  const [failed, setFailed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const abort = new AbortController();
    void getSession(abort.signal).then(setSession).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
    });
    return () => abort.abort();
  }, []);

  const intendedDestination = `${location.pathname}${location.search}`;
  const unauthorizedTarget = `/unauthorized?${new URLSearchParams({ returnTo: intendedDestination }).toString()}`;
  if (failed) return <Navigate to={unauthorizedTarget} replace />;
  if (session === undefined) return <main className="grid min-h-screen place-items-center"><LoaderCircle className="animate-spin text-[#158864]" aria-label="Loading session" /></main>;
  if (!session.authenticated) return <Navigate to={unauthorizedTarget} replace />;
  const firstName = session.persona.displayName.split(/\s+/)[0];
  const endSession = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logout(await getCsrf());
      await navigate('/login', { replace: true });
    } catch {
      setLoggingOut(false);
      setFailed(true);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b bg-[#182D2A] px-5 py-4 text-[#DEF6EF] sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-3"><ShieldCheck className="text-[#81E5AC]" /><span className="font-semibold">SlaCato</span></div>
          <div className="flex items-center gap-2">
            <Button asChild variant="secondary" size="sm"><Link to="/login">Change persona</Link></Button>
            <Button className="border-[#81E5AC]/40 text-[#DEF6EF] hover:bg-[#0D483D]" variant="outline" size="sm" disabled={loggingOut} onClick={() => void endSession()}>
              {loggingOut ? 'Signing out…' : 'Log out'}
            </Button>
          </div>
        </div>
      </header>
      <section className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-16">
        <Badge className="mb-4 bg-[#DEF6EF] text-[#0D483D]">Demo workspace</Badge>
        <h1 className="text-3xl font-semibold tracking-[-0.03em] sm:text-5xl">Welcome, {firstName}</h1>
        <p className="mt-4 max-w-2xl text-lg leading-7 text-muted-foreground">Your server-authorized session is active. The deal workspace arrives in the next implementation slice.</p>
        <Card className="mt-9 max-w-xl">
          <CardHeader><CardTitle>Active persona</CardTitle></CardHeader>
          <CardContent className="flex items-center justify-between gap-4">
            <div><p className="font-medium">{session.persona.displayName}</p><p className="text-sm text-muted-foreground">{session.persona.role}</p></div>
            <Button asChild variant="outline"><Link to="/login">Switch <ArrowRight /></Link></Button>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
