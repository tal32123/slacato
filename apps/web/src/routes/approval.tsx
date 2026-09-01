import type { ApprovalDetailResponse, DemoSession } from '@slacato/contracts';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import type { LoaderFunctionArgs } from 'react-router';
import { Link, useLoaderData, useRouteLoaderData } from 'react-router';
import {
  queryClient,
  SessionInvalidatedError,
  sessionQueryOptions,
  sessionRuntime
} from '@/api/session';
import { type ProductStatus, StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { ApprovalDecisionForm } from '@/features/approvals/approval-decision-form';
import { approvalDetailQueryOptions } from '@/features/approvals/queries';
import { ApprovalSubjectDetail } from '@/features/approvals/subject-section';
import {
  type UseApprovalDecisionResult,
  useApprovalDecision
} from '@/features/approvals/use-approval-decision';
import { EvidenceExplorer } from '@/features/briefs/evidence-explorer';
import { throwProtectedLoaderError } from './loader-security';

/** Loads the requested approval while preserving protected-session transition guarantees. */
export async function approvalLoader({
  request,
  params
}: LoaderFunctionArgs): Promise<ApprovalDetailResponse | null> {
  const subjectId = params.subjectId;
  if (!subjectId) throw new Response('Invalid approval route', { status: 400 });
  try {
    const session = await queryClient.fetchQuery(sessionQueryOptions());
    if (!session.authenticated) return null;
    return await queryClient.fetchQuery(approvalDetailQueryOptions(session.version, subjectId));
  } catch (error) {
    if (error instanceof SessionInvalidatedError) {
      try {
        const session = await queryClient.fetchQuery(sessionQueryOptions());
        if (session.authenticated) {
          const response = await queryClient.fetchQuery(
            approvalDetailQueryOptions(session.version, subjectId)
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

/** Presents the requested approval and keeps its server-backed detail current. */
export function ApprovalRoute(): React.JSX.Element {
  const initial = useLoaderData() as ApprovalDetailResponse;
  const session = useRouteLoaderData('protected-root') as DemoSession;
  const query = useQuery({
    ...approvalDetailQueryOptions(session.version, initial.approvalSubjectId),
    initialData: initial
  });
  return (
    <ApprovalDecisionPage
      key={query.data.approvalSubjectId}
      detail={query.data}
      session={session}
      refetch={() => query.refetch()}
    />
  );
}

/** Lets an authorized reviewer inspect, edit, approve, or reject a validated brief. */
function ApprovalDecisionPage({
  detail,
  session,
  refetch
}: Readonly<{
  detail: ApprovalDetailResponse;
  session: DemoSession;
  refetch: () => Promise<unknown>;
}>): React.JSX.Element {
  const decision = useApprovalDecision(detail, session, refetch);
  return (
    <EvidenceExplorer evidence={detail.evidence}>
      {({ onEvidence }) => (
        <ApprovalDecisionContent detail={detail} decision={decision} onEvidence={onEvidence} />
      )}
    </EvidenceExplorer>
  );
}

/** Renders the approval content inside the shared evidence explorer. */
function ApprovalDecisionContent({
  detail,
  decision,
  onEvidence
}: Readonly<{
  detail: ApprovalDetailResponse;
  decision: UseApprovalDecisionResult;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
}>): React.JSX.Element {
  return (
    <article className="min-w-0" aria-labelledby="approval-title">
      <Button asChild variant="link" className="min-h-11 px-0">
        <Link to="/approvals">
          <ArrowLeft aria-hidden="true" />
          Back to approval inbox
        </Link>
      </Button>
      <header className="mt-3 border-b pb-7">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge {...approvalStatus(detail.status)} />
          <span className="text-xs text-muted-foreground">
            Quorum {detail.quorum.completed} of {detail.quorum.required}
          </span>
        </div>
        <p className="mt-4 text-sm font-medium text-primary">{detail.opportunityId}</p>
        <h1
          id="approval-title"
          className="mt-1 break-words text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          {detail.opportunityName}
        </h1>
        <p className="mt-3 text-muted-foreground">
          {detail.accountName} · Immutable review subject
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to={`/runs/${encodeURIComponent(detail.runId)}`}>View run</Link>
          </Button>
          {detail.capabilities.canReadDeal && (
            <Button asChild variant="outline">
              <Link to={`/deals/${encodeURIComponent(detail.opportunityId)}`}>View deal</Link>
            </Button>
          )}
        </div>
      </header>

      {detail.supersededBySubjectId !== null && (
        <aside className="mt-6 rounded-xl border border-attention bg-attention/10 p-5">
          <h2 className="font-semibold">This subject was replaced by an approved edit</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Decisions against this immutable snapshot are closed.
          </p>
          <Button asChild className="mt-4">
            <Link to={`/approvals/${encodeURIComponent(detail.supersededBySubjectId)}`}>
              Open current subject
            </Link>
          </Button>
        </aside>
      )}
      {decision.blocked && (
        <aside className="mt-6 flex items-start gap-3 rounded-xl border border-attention bg-attention/10 p-5">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 text-attention-foreground" />
          <div>
            <h2 className="font-semibold">Waiting on an underlying approval</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your authority can operate a later entry after its dependency is satisfied. Editing
              alone never advances the run.
            </p>
          </div>
        </aside>
      )}

      <section className="border-b py-7" aria-labelledby="requirements-title">
        <h2 id="requirements-title" className="text-xl font-semibold">
          Required approvals
        </h2>
        <ul className="mt-4 grid gap-3">
          {detail.entries.map((entry) => (
            <li
              key={entry.entryId}
              className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div>
                <p className="font-medium">{label(entry.category)}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Required: {entry.requiredAuthorities.map(label).join(' or ')}
                </p>
                {entry.policyTriggers.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Reasons: {entry.policyTriggers.map(label).join(', ')}
                  </p>
                )}
                {entry.dependsOn.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Depends on {entry.dependsOn.join(', ')}
                  </p>
                )}
              </div>
              <StatusBadge
                status={
                  entry.decided
                    ? 'ready'
                    : entry.availableAuthority !== null
                      ? 'attention'
                      : 'readonly'
                }
                label={
                  entry.decided
                    ? 'Decided'
                    : entry.availableAuthority !== null
                      ? `Your authority: ${label(entry.availableAuthority)}`
                      : 'Not your authority'
                }
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="border-b py-7" aria-labelledby="subject-title">
        <h2 id="subject-title" className="text-xl font-semibold">
          Validated brief under review
        </h2>
        <ApprovalSubjectDetail
          payload={detail.payload}
          evidenceIds={decision.evidenceIds}
          onEvidence={onEvidence}
        />
      </section>

      <ApprovalDecisionForm detail={detail} decision={decision} />

      <section className="py-7" aria-labelledby="history-title">
        <h2 id="history-title" className="text-xl font-semibold">
          Decision history
        </h2>
        {detail.decisions.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No decisions recorded yet.</p>
        ) : (
          <ol className="mt-4 grid gap-3">
            {detail.decisions.map((record) => (
              <li key={`${record.decidedAt}:${record.actorName}`} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    status={record.action === 'reject' ? 'attention' : 'ready'}
                    label={label(record.action)}
                  />
                  <span className="text-sm font-medium">{record.actorName}</span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {label(record.authority)} ·{' '}
                  <time dateTime={record.decidedAt}>{formatTime(record.decidedAt)}</time>
                  {record.changed ? ' · Subject changed' : ''}
                </p>
                {record.rationale && <p className="mt-3 text-sm leading-6">{record.rationale}</p>}
                {record.diff && (
                  <div className="mt-4 rounded-lg bg-muted/50 p-4">
                    <p className="text-sm font-medium">Recorded changes</p>
                    {record.diff.fields.length > 0 && (
                      <dl className="mt-2 grid gap-3">
                        {record.diff.fields.map((field) => (
                          <div key={field.field}>
                            <dt className="text-xs font-medium uppercase text-muted-foreground">
                              {label(field.field)}
                            </dt>
                            <dd className="mt-1 text-sm">
                              <span className="line-through">{field.before}</span> → {field.after}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    <p className="mt-3 text-xs text-muted-foreground">
                      Sections changed:{' '}
                      {record.diff.changedSections.map(label).join(', ') || 'None'}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

/** Converts an internal approval value into a user-facing label. */
function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
/** Maps an approval outcome to its user-facing status presentation. */
function approvalStatus(status: ApprovalDetailResponse['status']): {
  status: ProductStatus;
  label: string;
} {
  if (status === 'completed') return { status: 'ready', label: 'Completed' };
  if (status === 'rejected') return { status: 'attention', label: 'Rejected' };
  if (status === 'failed') return { status: 'attention', label: 'Failed' };
  if (status === 'finalizing') return { status: 'unavailable', label: 'Finalizing' };
  if (status === 'awaiting_approval') return { status: 'attention', label: 'Approval review' };
  return { status: 'readonly', label: label(status) };
}
/** Formats an approval timestamp for the user's locale. */
function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}
