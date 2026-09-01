import type {
  ApprovalDetailResponse,
  DemoSession,
  GeneratedDealOutputView
} from '@slacato/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { StatusBadge } from '@/components/status-badge';
import { ApprovalDecisionForm } from './approval-decision-form';
import { approvalDetailQueryOptions } from './queries';
import { useApprovalDecision } from './use-approval-decision';

/** Loads and presents the existing approval decision controls inside a generated deal brief. */
export function DealApprovalDecision({
  approvalReview,
  session,
  onWorkspaceRevalidate
}: Readonly<{
  approvalReview: GeneratedDealOutputView['approvalReview'];
  session: DemoSession;
  onWorkspaceRevalidate: () => Promise<void> | void;
}>): React.JSX.Element | null {
  if (approvalReview === null) return null;
  return (
    <LoadedDealApprovalDecision
      key={approvalReview.approvalSubjectId}
      approvalSubjectId={approvalReview.approvalSubjectId}
      session={session}
      onWorkspaceRevalidate={onWorkspaceRevalidate}
    />
  );
}

/** Keeps the approval detail current without blocking the rest of the brief. */
function LoadedDealApprovalDecision({
  approvalSubjectId,
  session,
  onWorkspaceRevalidate
}: Readonly<{
  approvalSubjectId: string;
  session: DemoSession;
  onWorkspaceRevalidate: () => Promise<void> | void;
}>): React.JSX.Element {
  const query = useQuery(approvalDetailQueryOptions(session.version, approvalSubjectId));

  if (query.isError) {
    return (
      <div role="alert" className="border-b py-5 text-sm text-muted-foreground">
        <p>Approval controls are temporarily unavailable.</p>
        <Link
          className="mt-2 inline-flex font-medium text-primary underline-offset-4 hover:underline"
          to={`/approvals/${encodeURIComponent(approvalSubjectId)}`}
        >
          Open the approval review
        </Link>
      </div>
    );
  }

  if (query.data === undefined) {
    return (
      <p role="status" aria-live="polite" className="border-b py-5 text-sm text-muted-foreground">
        Loading approval decision…
      </p>
    );
  }

  return (
    <DealApprovalDecisionForm
      key={query.data.approvalSubjectId}
      detail={query.data}
      session={session}
      refetch={async () => {
        const result = await query.refetch();
        await onWorkspaceRevalidate();
        return result;
      }}
    />
  );
}

/** Binds one approval subject to the shared decision state machine and form. */
function DealApprovalDecisionForm({
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
    <>
      <DealApprovalRequirementContext detail={detail} />
      <ApprovalDecisionForm detail={detail} decision={decision} />
    </>
  );
}

/** Keeps the policy context visible beside actionable, blocked, and completed requirements. */
function DealApprovalRequirementContext({
  detail
}: Readonly<{
  detail: ApprovalDetailResponse;
}>): React.JSX.Element {
  return (
    <section className="border-b py-7" aria-labelledby="deal-approval-requirements-title">
      <h2 id="deal-approval-requirements-title" className="text-xl font-semibold">
        Approval requirements
      </h2>
      <ul className="mt-4 grid gap-3">
        {detail.entries.map((entry) => (
          <li
            key={entry.entryId}
            className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <p className="font-medium">{approvalLabel(entry.category)}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Required: {entry.requiredAuthorities.map(approvalLabel).join(' or ')}
              </p>
              {entry.policyTriggers.length > 0 && (
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  Reasons: {entry.policyTriggers.map(approvalLabel).join(', ')}
                </p>
              )}
              {entry.dependsOn.length > 0 && (
                <p className="mt-1 break-words text-xs text-muted-foreground">
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
                    ? `Your authority: ${approvalLabel(entry.availableAuthority)}`
                    : 'Not your authority'
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Converts an approval contract value into the label used by the standalone approval review. */
function approvalLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
