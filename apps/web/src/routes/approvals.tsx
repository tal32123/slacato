import type { ApprovalInboxEntry, ApprovalInboxResponse } from '@slacato/contracts';
import { Inbox, Scale } from 'lucide-react';
import type { LoaderFunctionArgs } from 'react-router';
import { Link, useLoaderData } from 'react-router';
import {
  queryClient,
  SessionInvalidatedError,
  sessionQueryOptions,
  sessionRuntime
} from '@/api/session';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { approvalsQueryOptions } from '@/features/approvals/queries';
import { throwProtectedLoaderError } from './loader-security';

/** Loads the approval inbox while preserving protected-session transition guarantees. */
export async function approvalsLoader({
  request
}: LoaderFunctionArgs): Promise<ApprovalInboxResponse | null> {
  try {
    const session = await queryClient.fetchQuery(sessionQueryOptions());
    if (!session.authenticated) return null;
    return await queryClient.fetchQuery(approvalsQueryOptions(session.version));
  } catch (error) {
    if (error instanceof SessionInvalidatedError) {
      try {
        const session = await queryClient.fetchQuery(sessionQueryOptions());
        if (session.authenticated) {
          const response = await queryClient.fetchQuery(approvalsQueryOptions(session.version));
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

/** Presents approval work grouped by items awaiting action and completed decisions. */
export function ApprovalsRoute(): React.JSX.Element {
  const response = useLoaderData() as ApprovalInboxResponse;
  return (
    <section data-tour="approvals" aria-labelledby="approvals-title">
      <header className="max-w-4xl">
        <p className="text-sm font-medium text-primary">Authority-scoped decisions</p>
        <h1 id="approvals-title" className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Approval inbox
        </h1>
        <p className="mt-3 leading-7 text-muted-foreground">
          Only categories your current persona can operate are shown. Every decision is bound to an
          immutable subject hash and current run version.
        </p>
      </header>
      <ApprovalSection
        title="Pending"
        entries={response.pending}
        empty="No approvals currently require your authority."
        pending
      />
      <ApprovalSection
        title="Decision history"
        entries={response.history}
        empty="No approval decisions are visible for this persona."
      />
    </section>
  );
}

/** Displays one approval-inbox section with a clear empty or loading state. */
function ApprovalSection({
  title,
  entries,
  empty,
  pending = false
}: Readonly<{
  title: string;
  entries: readonly ApprovalInboxEntry[];
  empty: string;
  pending?: boolean;
}>): React.JSX.Element {
  return (
    <section className="mt-9" aria-labelledby={`approval-${pending ? 'pending' : 'history'}`}>
      <div className="flex items-center gap-2">
        <h2 id={`approval-${pending ? 'pending' : 'history'}`} className="text-xl font-semibold">
          {title}
        </h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
          {entries.length}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed p-6 text-center">
          <Inbox aria-hidden="true" className="mx-auto size-7 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{empty}</p>
        </div>
      ) : (
        <ul className="mt-4 grid gap-3">
          {entries.map((entry) => (
            <ApprovalRow
              key={`${entry.approvalSubjectId}:${entry.entryId}`}
              entry={entry}
              pending={pending}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Summarizes one approval request, its authority, and its available next action. */
function ApprovalRow({
  entry,
  pending
}: Readonly<{ entry: ApprovalInboxEntry; pending: boolean }>): React.JSX.Element {
  return (
    <li className="grid min-w-0 gap-4 rounded-xl border bg-card p-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(14rem,0.8fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            status={pending || entry.decision?.action === 'reject' ? 'attention' : 'ready'}
            label={pending ? 'Decision required' : decisionLabel(entry)}
          />
          <span className="text-xs text-muted-foreground">{categoryLabel(entry.category)}</span>
        </div>
        <h3 className="mt-3 break-words text-lg font-semibold">{entry.opportunityName}</h3>
        <p className="mt-1 break-words text-sm text-muted-foreground">
          {entry.accountName} · {entry.opportunityId}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Authority</dt>
        <dd className="break-words">
          {authorityLabel(entry.decision?.authority ?? entry.availableAuthority)}
        </dd>
        <dt className="text-muted-foreground">Quorum</dt>
        <dd>
          {entry.quorum.completed} of {entry.quorum.required}
        </dd>
        <dt className="text-muted-foreground">Assigned</dt>
        <dd className="break-words">{entry.assignedApprover ?? 'Unassigned authority pool'}</dd>
        <dt className="text-muted-foreground">Age</dt>
        <dd>
          <time dateTime={entry.ageStartedAt}>{age(entry.ageStartedAt)}</time>
        </dd>
      </dl>
      <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
        <Button asChild>
          <Link to={`/approvals/${encodeURIComponent(entry.approvalSubjectId)}`}>
            {pending ? 'Review' : 'View decision'}
            <Scale aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to={`/runs/${encodeURIComponent(entry.runId)}`}>View run</Link>
        </Button>
      </div>
    </li>
  );
}

/** Converts a recorded approval decision into a concise outcome label. */
function decisionLabel(entry: ApprovalInboxEntry): string {
  return entry.decision?.action === 'reject'
    ? 'Rejected'
    : entry.decision?.changed
      ? 'Edited and approved'
      : 'Approved';
}
/** Converts an approval category into a user-facing label. */
function categoryLabel(value: ApprovalInboxEntry['category']): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
/** Converts an approval authority into a user-facing label. */
function authorityLabel(
  value:
    | ApprovalInboxEntry['availableAuthority']
    | NonNullable<ApprovalInboxEntry['decision']>['authority']
): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
/** Expresses how long an approval item has been waiting in a compact form. */
function age(value: string): string {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
  return hours < 1 ? 'Less than an hour' : hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
