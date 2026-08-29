import type { DemoDiagnosticsResponse, DemoSession, ProviderHealthView } from '@slacato/contracts';
import { ArrowLeft, Bot, Database, SearchCheck, ServerCog } from 'lucide-react';
import { Link, useLoaderData, useRouteLoaderData } from 'react-router';
import { diagnosticsQueryOptions, queryClient, sessionQueryOptions } from '@/api/session';
import { PermissionMatrix } from '@/components/permission-matrix';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export async function diagnosticsLoader(): Promise<DemoDiagnosticsResponse | null> {
  const session = await queryClient.ensureQueryData(sessionQueryOptions());
  if (!session.authenticated) return null;
  return queryClient.ensureQueryData(diagnosticsQueryOptions(session.version));
}

export function DiagnosticsRoute(): React.JSX.Element {
  const diagnostics = useLoaderData() as DemoDiagnosticsResponse;
  const session = useRouteLoaderData('protected-root') as DemoSession;
  const health = diagnostics.providerHealth;
  const dependencyChecks = Object.entries(health.checks) as Array<[
    keyof ProviderHealthView['checks'],
    ProviderHealthView['checks'][keyof ProviderHealthView['checks']]
  ]>;

  return (
    <div className="grid gap-8">
      <header className="max-w-4xl">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-medium text-primary">Settings / Demo Diagnostics</p>
          <StatusBadge status="readonly" />
        </div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Demo Diagnostics</h1>
        <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">
          SlaCato is a negotiation-preparation assistant. Its recommendations are internal, evidence-backed suggestions; sellers own judgment, and no control autonomously sends customer-facing content.
        </p>
        <Button asChild variant="link" className="mt-3 min-h-11 px-0"><Link to="/settings"><ArrowLeft aria-hidden="true" />Back to Persona &amp; session</Link></Button>
      </header>

      <section aria-labelledby="runtime-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="runtime-title" className="text-xl font-semibold">Runtime configuration</h2>
            <p className="mt-1 text-sm text-muted-foreground">Pinned, server-reported facts for this process. These controls cannot be changed here.</p>
          </div>
          <StatusBadge status={health.runtimeReadiness === 'ready' ? 'ready' : 'attention'} label={health.runtimeReadiness === 'ready' ? 'Runtime ready' : 'Runtime not ready'} />
        </div>
        <Card className="shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2"><ServerCog aria-hidden="true" className="size-5 text-primary" />Provider and readiness</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
              <DiagnosticValue icon={Bot} label="Provider" value={health.provider === 'mock' ? 'Mock development provider' : 'Ollama'} />
              <DiagnosticValue icon={Bot} label="Output mode" value={outputModeLabel(health.outputMode)} />
              <DiagnosticValue icon={Bot} label="Pinned generation model" value={health.pinnedGenerationModel} />
              <DiagnosticValue icon={SearchCheck} label="Pinned embedding model" value={health.pinnedEmbeddingModel} />
              <DiagnosticValue icon={Database} label="Index health" value={readinessLabel(health.indexHealth)} />
              <DiagnosticValue icon={ServerCog} label="Runtime readiness" value={health.runtimeReadiness === 'ready' ? 'Ready' : 'Not ready'} />
            </dl>
            <div className="mt-6 border-t pt-5">
              <h3 className="text-sm font-semibold">Dependency checks</h3>
              <ul className="mt-3 flex flex-wrap gap-2" aria-label="Runtime dependency checks">
                {dependencyChecks.map(([name, status]) => (
                  <li key={name}><StatusBadge status={status === 'ready' ? 'ready' : 'unavailable'} label={`${dependencyLabel(name)}: ${readinessLabel(status)}`} /></li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="permissions-title">
        <div className="mb-4 max-w-4xl">
          <h2 id="permissions-title" className="text-xl font-semibold">Canonical permission view</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Grants shown for {session.persona.displayName} separate the ability to request a decision from Account Owner, Sales Leader, Deal Desk, and Legal Reviewer authority. A request never grants decision authority.
          </p>
        </div>
        <PermissionMatrix grants={diagnostics.permissions} />
      </section>
    </div>
  );
}

function DiagnosticValue({ icon: Icon, label, value }: Readonly<{
  icon: typeof Bot;
  label: string;
  value: string;
}>): React.JSX.Element {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
      <Icon aria-hidden="true" className="mt-0.5 size-5 text-primary" />
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="col-start-2 mt-1 break-words text-sm font-medium">{value}</dd>
    </div>
  );
}

function outputModeLabel(mode: ProviderHealthView['outputMode']): string {
  return mode === 'deterministic_mock' ? 'Deterministic development output' : 'Capability probe required';
}

function readinessLabel(status: 'ready' | 'unavailable'): string {
  return status === 'ready' ? 'Ready' : 'Unavailable';
}

function dependencyLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
