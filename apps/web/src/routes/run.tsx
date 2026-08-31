import type { DemoSession, RunDetailResponse, RunStatus } from '@slacato/contracts';
import { runEventEnvelopeSchema } from '@slacato/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock3,
  RotateCcw
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LoaderFunctionArgs } from 'react-router';
import { Link, useLoaderData, useRouteLoaderData } from 'react-router';
import { cancelRun, fetchCsrf } from '@/api/client';
import {
  queryClient,
  queryKeys,
  SessionInvalidatedError,
  sessionQueryOptions,
  sessionRuntime
} from '@/api/session';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { runDetailQueryOptions } from '@/features/runs/queries';
import { applyRunEvent, openRunEventStream, type RunStreamSource } from '@/features/runs/stream';
import { throwProtectedLoaderError } from './loader-security';
import { statusLabel } from './runs';

/** Loads the requested run while preserving protected-session transition guarantees. */
export async function runLoader({
  request,
  params
}: LoaderFunctionArgs): Promise<RunDetailResponse | null> {
  const runId = params.runId;
  if (!runId) throw new Response('Invalid run route', { status: 400 });
  try {
    const session = await queryClient.fetchQuery(sessionQueryOptions());
    if (!session.authenticated) return null;
    return await queryClient.fetchQuery(runDetailQueryOptions(session.version, runId));
  } catch (error) {
    if (error instanceof SessionInvalidatedError) {
      try {
        const session = await queryClient.fetchQuery(sessionQueryOptions());
        if (session.authenticated) {
          const response = await queryClient.fetchQuery(
            runDetailQueryOptions(session.version, runId)
          );
          sessionRuntime.finishTransition();
          return response;
        }
      } catch (retryError) {
        throwProtectedLoaderError(retryError, request);
      }
    }
    throwProtectedLoaderError(error, request);
  }
}

/** Presents live workflow progress, outcomes, and the next available action for a run. */
export function RunRoute(): React.JSX.Element {
  const initial = useLoaderData() as RunDetailResponse;
  const session = useRouteLoaderData('protected-root') as DemoSession;
  const query = useQuery({
    ...runDetailQueryOptions(session.version, initial.runId),
    initialData: initial
  });
  const detail = query.data;
  const [connection, setConnection] = useState<
    'connecting' | 'connected' | 'reconnecting' | 'offline'
  >('connecting');
  const [, rerenderStalled] = useState(0);
  const [streamEpoch, restartStream] = useState(0);
  const cancellation = useMutation({
    mutationFn: async () => cancelRun(detail.runId, await fetchCsrf()),
    onSuccess: async () => {
      await Promise.all([
        query.refetch(),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, 'runs') }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.scoped(session.version, `deal:${detail.opportunityId}`)
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, 'deals') })
      ]);
    }
  });

  useEffect(() => {
    const onOffline = (): void => setConnection('offline');
    const onOnline = (): void => {
      setConnection('reconnecting');
      restartStream((value) => value + 1);
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  useEffect(() => {
    if (detail.terminal) return;
    const timer = window.setInterval(() => rerenderStalled((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [detail.terminal]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Only run, terminal, session, and epoch changes reconnect the stream.
  useEffect(() => {
    const generation = sessionRuntime.generation;
    let reconnectTimer: number | undefined;
    const close = openRunEventStream({
      detail,
      generation,
      currentGeneration: () => sessionRuntime.generation,
      createSource: (url) => new EventSource(url, { withCredentials: true }) as RunStreamSource,
      registerStream: (source) => sessionRuntime.registerStream(source),
      onEvent: (candidate) => {
        const parsed = runEventEnvelopeSchema.safeParse(candidate);
        queryClient.setQueryData<RunDetailResponse>(
          queryKeys.scoped(session.version, `run:${detail.runId}`),
          (current) =>
            current === undefined
              ? current
              : applyRunEvent(current, candidate, generation, sessionRuntime.generation)
        );
        if (!parsed.success) return;
        const transition =
          parsed.data.type.startsWith('approval_') ||
          parsed.data.type === 'awaiting_approval' ||
          parsed.data.type === 'complete' ||
          parsed.data.type === 'fail';
        if (transition) {
          void Promise.all([
            queryClient.invalidateQueries({
              queryKey: queryKeys.scoped(session.version, `run:${detail.runId}`)
            }),
            queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, 'runs') }),
            queryClient.invalidateQueries({
              queryKey: queryKeys.scoped(session.version, `deal:${detail.opportunityId}`)
            }),
            queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, 'deals') }),
            queryClient.invalidateQueries({
              queryKey: queryKeys.scoped(session.version, 'approvals')
            })
          ]);
          return;
        }
        if (
          [
            'retrieval_completed',
            'specialists_completed',
            'synthesis_completed',
            'validation_completed',
            'validation_requires_approval',
            'checkpoint_committed'
          ].includes(parsed.data.type)
        ) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.scoped(session.version, `run:${detail.runId}`)
          });
        }
      },
      onConnection: (state) => {
        setConnection(state);
        if (state === 'connected' && reconnectTimer !== undefined) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        } else if (state === 'reconnecting' && navigator.onLine && reconnectTimer === undefined) {
          reconnectTimer = window.setTimeout(() => restartStream((value) => value + 1), 1_000);
        }
      },
      onResync: () => {
        void query.refetch().then((result) => {
          if (result.data !== undefined) restartStream((value) => value + 1);
        });
      }
    });
    return () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      close();
    };
  }, [detail.runId, detail.terminal, session.version, streamEpoch]);

  const stalled = !detail.terminal && Date.now() - new Date(detail.updatedAt).getTime() > 60_000;
  const progress = progressView(detail);
  return (
    <article className="min-w-0" aria-labelledby="run-title">
      <Button asChild variant="link" className="min-h-11 px-0">
        <Link to="/runs">
          <ArrowLeft aria-hidden="true" />
          Back to runs
        </Link>
      </Button>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        Run phase: {statusLabel(detail.status)}
      </p>
      <header className="mt-3 border-b pb-7">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            status={
              detail.status === 'completed'
                ? 'ready'
                : ['failed', 'rejected', 'awaiting_approval'].includes(detail.status)
                  ? 'attention'
                  : 'readonly'
            }
            label={statusLabel(detail.status)}
          />
          {!detail.terminal && <ConnectionBadge connection={connection} stalled={stalled} />}
        </div>
        <p className="mt-4 text-sm font-medium text-primary">{detail.opportunityId}</p>
        <h1
          id="run-title"
          className="mt-1 break-words text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          {detail.opportunityName}
        </h1>
        <p className="mt-3 text-muted-foreground">
          {detail.accountName} · Initiated by {detail.initiatedBy}
        </p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Last updated <time dateTime={detail.updatedAt}>{formatTime(detail.updatedAt)}</time>
          </p>
          {!detail.terminal && (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <p className="text-xs text-muted-foreground">
                This run is active. Cancel it before starting another run.
              </p>
              <Button
                data-tour="run-primary-action"
                variant="destructive"
                disabled={cancellation.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      'Cancel this run? Persisted progress and history will be retained, but processing will stop.'
                    )
                  )
                    cancellation.mutate();
                }}
              >
                <Ban aria-hidden="true" />
                {cancellation.isPending ? 'Cancelling…' : 'Cancel run'}
              </Button>
            </div>
          )}
        </div>
        {cancellation.isError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            The run could not be cancelled. Refresh to check its latest state and try again.
          </p>
        )}
      </header>

      <RunStateNotice detail={detail} stalled={stalled} />

      <section
        data-tour="run-progress-detail"
        className="border-b py-7"
        aria-labelledby="progress-title"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-primary">Current phase</p>
            <h2 id="progress-title" className="mt-1 text-xl font-semibold">
              {statusLabel(detail.progress.phase)}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">{progress.label}</p>
        </div>
        <Progress
          className="mt-4"
          value={progress.value}
          aria-label="Workflow progress"
          aria-valuetext={progress.valueText}
        />
        <dl className="mt-6 grid gap-3 sm:grid-cols-3">
          <Fact label="Authorized evidence" value={`${detail.progress.retrievalCount} items`} />
          <Fact label="Validation retries" value={String(detail.progress.validationRetries)} />
          <Fact
            label="Validated sections"
            value={`${detail.progress.completedSections.length} of 9`}
          />
        </dl>
      </section>

      <section className="border-b py-7" aria-labelledby="specialists-title">
        <h2 id="specialists-title" className="text-xl font-semibold">
          Specialists
        </h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-3">
          {detail.progress.specialists.map((specialist) => (
            <li key={specialist.name} className="rounded-lg border bg-card p-4">
              <p className="font-medium capitalize">{specialist.name}</p>
              <p className="mt-1 text-sm capitalize text-muted-foreground">{specialist.status}</p>
            </li>
          ))}
        </ul>
      </section>

      {detail.progress.completedSections.length > 0 && (
        <section className="border-b py-7" aria-labelledby="sections-title">
          <h2 id="sections-title" className="text-xl font-semibold">
            Completed validated sections
          </h2>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {detail.progress.completedSections.map((section) => (
              <li key={section} className="flex items-center gap-2 text-sm">
                <CheckCircle2 aria-hidden="true" className="size-4 text-primary" />
                {section}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="py-7" aria-labelledby="timeline-title">
        <h2 id="timeline-title" className="text-xl font-semibold">
          Persisted timeline
        </h2>
        {detail.progress.timeline.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            The run is queued; the first persisted milestone will appear here.
          </p>
        ) : (
          <ol className="mt-5 grid gap-4">
            {detail.progress.timeline.map((item) => (
              <li key={item.eventId} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                <CircleDashed aria-hidden="true" className="mt-0.5 size-5 text-primary" />
                <div>
                  <p className="font-medium">{item.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <time dateTime={item.at}>{formatTime(item.at)}</time>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

/** Summarizes whether live run updates are healthy, delayed, or disconnected. */
function ConnectionBadge({
  connection,
  stalled
}: Readonly<{ connection: string; stalled: boolean }>): React.JSX.Element {
  const label =
    connection === 'offline'
      ? 'Offline'
      : connection === 'reconnecting'
        ? 'Reconnecting'
        : stalled
          ? 'Progress delayed'
          : connection === 'connected'
            ? 'Live'
            : 'Connecting';
  return (
    <StatusBadge
      status={connection === 'connected' && !stalled ? 'ready' : 'attention'}
      label={label}
    />
  );
}

/** Explains terminal, approval, failure, cancellation, or stalled states that need user attention. */
function RunStateNotice({
  detail,
  stalled
}: Readonly<{ detail: RunDetailResponse; stalled: boolean }>): React.JSX.Element | null {
  if (detail.status === 'awaiting_approval')
    return (
      <Notice
        icon={Clock3}
        title="Awaiting approval"
        text="The validated brief is persisted. An authorized approver must satisfy every required entry before finalization."
        action="Open approval inbox"
        href="/approvals"
      />
    );
  if (detail.status === 'completed')
    return (
      <Notice
        icon={CheckCircle2}
        title="Brief completed"
        text="The validated brief is available in the authorized deal workspace."
        action="View deal"
        href={`/deals/${encodeURIComponent(detail.opportunityId)}`}
      />
    );
  if (detail.status === 'rejected')
    return (
      <Notice
        icon={AlertTriangle}
        title="Approval rejected"
        text="This run is terminal, so there is nothing left to cancel. The approval decision and audit history remain available; start a new run from the deal when ready."
        action="Return to deal and run again"
        href={`/deals/${encodeURIComponent(detail.opportunityId)}`}
      />
    );
  if (detail.status === 'failed')
    return (
      <Notice
        icon={RotateCcw}
        title="Run failed safely"
        text="This run is terminal, so there is nothing left to cancel. No unvalidated output was published, and its audit history is retained. Start a new run from the deal when ready."
        action="Return to deal and run again"
        href={`/deals/${encodeURIComponent(detail.opportunityId)}`}
      />
    );
  if (detail.status === 'cancelled')
    return (
      <Notice
        icon={Ban}
        title="Run cancelled"
        text="Processing has stopped, so there is nothing left to cancel. Persisted checkpoints, artifacts, and audit history are retained. Start a new run from the deal when ready."
        action="Return to deal and run again"
        href={`/deals/${encodeURIComponent(detail.opportunityId)}`}
      />
    );
  if (stalled)
    return (
      <Notice
        icon={Clock3}
        title="Progress is taking longer than expected"
        text="The persisted state remains safe. This page will reconnect automatically; refreshing rejoins the same run."
      />
    );
  return null;
}

/** Presents an actionable run-state message with optional navigation to the next step. */
function Notice({
  icon: Icon,
  title,
  text,
  action,
  href
}: Readonly<{
  icon: typeof Clock3;
  title: string;
  text: string;
  action?: string;
  href?: string;
}>): React.JSX.Element {
  return (
    <aside className="mt-6 flex flex-col gap-4 rounded-xl border border-attention bg-attention/10 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-attention-foreground" />
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{text}</p>
        </div>
      </div>
      {action && href && (
        <Button asChild variant="outline">
          <Link data-tour="run-primary-action" to={href}>
            {action}
          </Link>
        </Button>
      )}
    </aside>
  );
}
/** Displays one labeled run fact for quick scanning. */
function Fact({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card p-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
    </div>
  );
}
/** Formats a recorded run timestamp for the user's locale. */
function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}
/** Maps a workflow state to its representative completion percentage. */
function progressPercent(status: RunStatus): number {
  const values: Record<RunStatus, number> = {
    created: 5,
    retrieving: 20,
    specialists_running: 40,
    synthesizing: 60,
    validating: 75,
    awaiting_approval: 82,
    finalizing: 92,
    completed: 100,
    rejected: 82,
    failed: 75,
    cancelled: 0
  };
  return values[status];
}
/** Builds the accessible progress presentation for the run's current state. */
function progressView(detail: RunDetailResponse): {
  value: number;
  label: string;
  valueText: string;
} {
  if (detail.status === 'completed')
    return { value: 100, label: '100% workflow complete', valueText: 'Workflow complete' };
  const terminal =
    detail.status === 'failed' || detail.status === 'rejected' || detail.status === 'cancelled';
  const previous = terminal
    ? ([...detail.progress.timeline]
        .reverse()
        .map((item) => item.phase)
        .find((phase) => phase !== 'failed' && phase !== 'rejected' && phase !== 'cancelled') ??
      'created')
    : detail.status;
  const value = progressPercent(previous);
  const phase = statusLabel(previous);
  if (terminal)
    return {
      value,
      label: `Stopped during ${phase}`,
      valueText: `${value}% complete; stopped during ${phase}`
    };
  return { value, label: `${value}% workflow progress`, valueText: `${value}% complete; ${phase}` };
}
