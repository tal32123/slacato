import type { RunListResponse, RunStatus } from '@slacato/contracts';
import type { LoaderFunctionArgs } from 'react-router';
import { ArrowRight, ListTodo } from 'lucide-react';
import { Link, useLoaderData } from 'react-router';
import { queryClient, sessionQueryOptions, sessionRuntime, SessionInvalidatedError } from '@/api/session';
import { StatusBadge, type ProductStatus } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { runsQueryOptions } from '@/features/runs/queries';
import { throwProtectedLoaderError } from './loader-security';

/** Loads the run history while preserving protected-session transition guarantees. */
export async function runsLoader({ request }: LoaderFunctionArgs): Promise<RunListResponse | null> {
  try {
    const session = await queryClient.fetchQuery(sessionQueryOptions());
    if (!session.authenticated) return null;
    return await queryClient.fetchQuery(runsQueryOptions(session.version));
  } catch (error) {
    if (error instanceof SessionInvalidatedError) {
      try {
        const session = await queryClient.fetchQuery(sessionQueryOptions());
        if (session.authenticated) {
          const response = await queryClient.fetchQuery(runsQueryOptions(session.version));
          sessionRuntime.finishTransition();
          return response;
        }
      } catch (retryError) { throwProtectedLoaderError(retryError, request); }
    }
    throwProtectedLoaderError(error, request);
  }
}

/** Presents recent workflow runs with their status, timing, and destination. */
export function RunsRoute(): React.JSX.Element {
  const response = useLoaderData() as RunListResponse;
  return (
    <section data-tour="run-progress" aria-labelledby="runs-title">
      <header className="max-w-4xl">
        <p className="text-sm font-medium text-primary">Persona-scoped workflow history</p>
        <h1 id="runs-title" className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Runs</h1>
        <p className="mt-3 leading-7 text-muted-foreground">Rejoin active work at its stable URL or inspect terminal outcomes. Every row is reauthorized for the current persona.</p>
      </header>
      {response.runs.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed p-8 text-center">
          <ListTodo aria-hidden="true" className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-4 text-lg font-semibold">No authorized runs</h2>
          <p className="mt-2 text-sm text-muted-foreground">Generate a brief from an authorized deal workspace to start one.</p>
          <Button asChild className="mt-5"><Link to="/deals">Open deals</Link></Button>
        </div>
      ) : (
        <ul className="mt-8 grid gap-3" aria-label="Authorized runs">
          {response.runs.map((run) => {
            const terminal = ['completed', 'rejected', 'failed', 'cancelled'].includes(run.status);
            return (
              <li key={run.runId} className="grid min-w-0 gap-4 rounded-xl border bg-card p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={badgeStatus(run.status)} label={statusLabel(run.status)} />
                    <span className="text-xs text-muted-foreground">{run.opportunityId}</span>
                  </div>
                  <h2 className="mt-3 break-words text-lg font-semibold">{run.opportunityName}</h2>
                  <p className="mt-1 break-words text-sm text-muted-foreground">{run.accountName} · Initiated by {run.initiatedBy}</p>
                  <p className="mt-2 text-xs text-muted-foreground">Updated <time dateTime={run.updatedAt}>{formatTime(run.updatedAt)}</time></p>
                </div>
                <Button asChild variant={terminal ? 'outline' : 'default'} className="w-full sm:w-auto">
                  <Link to={`/runs/${encodeURIComponent(run.runId)}`}>{terminal ? 'View' : 'Rejoin'}<ArrowRight aria-hidden="true" /></Link>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Converts a run state into the workflow label shown to users. */
export function statusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    created: 'Queued', retrieving: 'Retrieving evidence', specialists_running: 'Specialists running',
    synthesizing: 'Synthesizing', validating: 'Validating', awaiting_approval: 'Awaiting approval',
    finalizing: 'Finalizing', completed: 'Completed', rejected: 'Rejected', failed: 'Failed', cancelled: 'Cancelled'
  };
  return labels[status];
}

/** Chooses the visual emphasis appropriate to a run state. */
function badgeStatus(status: RunStatus): ProductStatus {
  if (status === 'completed') return 'ready';
  if (status === 'awaiting_approval' || status === 'rejected' || status === 'failed' || status === 'cancelled') return 'attention';
  return 'readonly';
}

/** Formats a run timestamp for the user's locale. */
function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
