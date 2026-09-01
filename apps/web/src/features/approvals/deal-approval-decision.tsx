import type { ApprovalDetailResponse, DemoSession, GeneratedDealOutputView } from '@slacato/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApprovalDecisionForm } from './approval-decision-form';
import { approvalDetailQueryOptions } from './queries';
import { useApprovalDecision } from './use-approval-decision';

/** Loads and presents the existing approval decision controls inside a generated deal brief. */
export function DealApprovalDecision({
  approvalReview,
  session
}: Readonly<{
  approvalReview: GeneratedDealOutputView['approvalReview'];
  session: DemoSession;
}>): React.JSX.Element | null {
  if (approvalReview === null) return null;
  return (
    <LoadedDealApprovalDecision
      key={approvalReview.approvalSubjectId}
      approvalSubjectId={approvalReview.approvalSubjectId}
      session={session}
    />
  );
}

/** Keeps the approval detail current without blocking the rest of the brief. */
function LoadedDealApprovalDecision({
  approvalSubjectId,
  session
}: Readonly<{
  approvalSubjectId: string;
  session: DemoSession;
}>): React.JSX.Element {
  const query = useQuery(approvalDetailQueryOptions(session.version, approvalSubjectId));

  if (query.isPending) {
    return (
      <p role="status" aria-live="polite" className="border-b py-5 text-sm text-muted-foreground">
        Loading approval decision…
      </p>
    );
  }

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

  return (
    <DealApprovalDecisionForm
      key={query.data.approvalSubjectId}
      detail={query.data}
      session={session}
      refetch={() => query.refetch()}
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
  return <ApprovalDecisionForm detail={detail} decision={decision} />;
}
