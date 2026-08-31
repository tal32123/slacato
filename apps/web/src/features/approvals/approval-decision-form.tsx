import type { ApprovalDetailResponse } from '@slacato/contracts';
import { CheckCircle2, FilePenLine, Gavel, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { UseApprovalDecisionResult } from './use-approval-decision';

/** Renders the approve/edit/reject decision controls and the resulting status feedback. */
export function ApprovalDecisionForm({
  detail,
  decision
}: Readonly<{
  detail: ApprovalDetailResponse;
  decision: UseApprovalDecisionResult;
}>): React.JSX.Element {
  return (
    <>
      {decision.mutable && (
        <section
          data-tour="approval-decision"
          className="border-b py-7"
          aria-labelledby="decision-title"
          aria-busy={decision.isPending}
        >
          <h2 id="decision-title" className="text-xl font-semibold">
            Record decision
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The decision uses the current run version and subject hash. A partial quorum remains
            awaiting approval.
          </p>
          {!detail.capabilities.canEditPayload && (
            <p className="mt-2 text-sm text-muted-foreground">
              Editing requires current access to every cited deal-evidence record. You can still
              approve the immutable brief unchanged or reject it.
            </p>
          )}
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button
              type="button"
              disabled={decision.isPending}
              onClick={() => decision.submit('approve_unchanged')}
            >
              <CheckCircle2 aria-hidden="true" />
              {decision.activeAction === 'approve_unchanged'
                ? 'Recording approval…'
                : 'Approve unchanged'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={decision.isPending || !detail.capabilities.canEditPayload}
              aria-expanded={decision.mode === 'edit'}
              aria-controls="edit-decision-fields"
              onClick={() => decision.setMode(decision.mode === 'edit' ? null : 'edit')}
            >
              <FilePenLine aria-hidden="true" />
              Edit and approve
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={decision.isPending}
              aria-expanded={decision.mode === 'reject'}
              aria-controls="reject-decision-fields"
              onClick={() => decision.setMode(decision.mode === 'reject' ? null : 'reject')}
            >
              <XCircle aria-hidden="true" />
              Reject
            </Button>
          </div>
          {decision.mode !== null && (
            <div
              id={decision.mode === 'edit' ? 'edit-decision-fields' : 'reject-decision-fields'}
              className="mt-5 grid gap-5 rounded-xl border bg-muted/30 p-5"
            >
              {decision.mode === 'edit' && (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="executive-summary">Executive summary</Label>
                    <Textarea
                      ref={decision.executiveSummaryRef}
                      id="executive-summary"
                      maxLength={8000}
                      value={decision.executiveSummary}
                      aria-invalid={decision.fieldErrors.executiveSummary ? true : undefined}
                      aria-describedby={
                        decision.fieldErrors.executiveSummary
                          ? 'executive-summary-error executive-summary-help'
                          : 'executive-summary-help'
                      }
                      onChange={(event) => decision.setExecutiveSummary(event.target.value)}
                    />
                    <p id="executive-summary-help" className="text-xs text-muted-foreground">
                      {decision.executiveSummary.length} of 8,000 characters
                    </p>
                    {decision.fieldErrors.executiveSummary && (
                      <p id="executive-summary-error" className="text-sm text-destructive">
                        {decision.fieldErrors.executiveSummary}
                      </p>
                    )}
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="negotiation-state">Negotiation state</Label>
                    <Textarea
                      ref={decision.negotiationStateRef}
                      id="negotiation-state"
                      maxLength={8000}
                      value={decision.negotiationState}
                      aria-invalid={decision.fieldErrors.negotiationState ? true : undefined}
                      aria-describedby={
                        decision.fieldErrors.negotiationState
                          ? 'negotiation-state-error negotiation-state-help'
                          : 'negotiation-state-help'
                      }
                      onChange={(event) => decision.setNegotiationState(event.target.value)}
                    />
                    <p id="negotiation-state-help" className="text-xs text-muted-foreground">
                      {decision.negotiationState.length} of 8,000 characters
                    </p>
                    {decision.fieldErrors.negotiationState && (
                      <p id="negotiation-state-error" className="text-sm text-destructive">
                        {decision.fieldErrors.negotiationState}
                      </p>
                    )}
                  </div>
                  <div className="grid max-w-xs gap-2">
                    <Label htmlFor="overall-confidence">Overall confidence</Label>
                    <Input
                      ref={decision.confidenceRef}
                      id="overall-confidence"
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={decision.confidence}
                      aria-invalid={
                        decision.fieldErrors.confidence || decision.fieldErrors.editedPayload
                          ? true
                          : undefined
                      }
                      aria-describedby={
                        decision.fieldErrors.confidence
                          ? 'confidence-error'
                          : decision.fieldErrors.editedPayload
                            ? 'edited-payload-error'
                            : undefined
                      }
                      onChange={(event) => decision.setConfidence(event.target.value)}
                    />
                    {decision.fieldErrors.confidence && (
                      <p id="confidence-error" className="text-sm text-destructive">
                        {decision.fieldErrors.confidence}
                      </p>
                    )}
                    {decision.fieldErrors.editedPayload && (
                      <p id="edited-payload-error" className="text-sm text-destructive">
                        {decision.fieldErrors.editedPayload}
                      </p>
                    )}
                  </div>
                  <section
                    aria-labelledby="change-preview-title"
                    className="rounded-lg border bg-card p-4"
                  >
                    <h3 id="change-preview-title" className="font-semibold">
                      Change preview
                    </h3>
                    {decision.preview.length === 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No review fields have changed.
                      </p>
                    ) : (
                      <dl className="mt-3 grid gap-4">
                        {decision.preview.map((field) => (
                          <div key={field.label}>
                            <dt className="font-medium">{field.label}</dt>
                            <dd className="mt-1 grid gap-2 text-sm sm:grid-cols-2">
                              <span className="rounded border p-3">
                                <strong className="block text-xs uppercase text-muted-foreground">
                                  Before
                                </strong>
                                {field.before}
                              </span>
                              <span className="rounded border p-3">
                                <strong className="block text-xs uppercase text-muted-foreground">
                                  After
                                </strong>
                                {field.after}
                              </span>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    <p className="mt-4 text-sm text-muted-foreground">
                      This decision completes{' '}
                      {Math.min(detail.quorum.completed + 1, detail.quorum.required)} of{' '}
                      {detail.quorum.required} approvals. Editing creates a new immutable subject
                      and never resumes the run by itself.
                    </p>
                  </section>
                </>
              )}
              <div className="grid gap-2">
                <Label htmlFor="decision-rationale">Rationale</Label>
                <Textarea
                  ref={decision.rationaleRef}
                  id="decision-rationale"
                  maxLength={4000}
                  value={decision.rationale}
                  aria-invalid={decision.fieldErrors.rationale ? true : undefined}
                  aria-describedby={
                    decision.fieldErrors.rationale
                      ? 'decision-rationale-error decision-rationale-help'
                      : 'decision-rationale-help'
                  }
                  onChange={(event) => decision.setRationale(event.target.value)}
                  placeholder={
                    decision.mode === 'reject'
                      ? 'Explain why this brief cannot proceed'
                      : 'Explain the approved edit'
                  }
                />
                <p id="decision-rationale-help" className="text-xs text-muted-foreground">
                  {decision.rationale.length} of 4,000 characters
                </p>
                {decision.fieldErrors.rationale && (
                  <p id="decision-rationale-error" className="text-sm text-destructive">
                    {decision.fieldErrors.rationale}
                  </p>
                )}
              </div>
              <Button
                type="button"
                disabled={decision.isPending}
                onClick={() =>
                  decision.submit(decision.mode === 'edit' ? 'edit_and_approve' : 'reject')
                }
              >
                <Gavel aria-hidden="true" />
                {decision.activeAction !== null
                  ? 'Recording decision…'
                  : decision.mode === 'edit'
                    ? 'Submit edit for approval'
                    : 'Confirm rejection'}
              </Button>
            </div>
          )}
          {decision.isError && (
            <div
              role="alert"
              className="mt-4 grid justify-items-start gap-2 text-sm text-destructive"
            >
              <p>
                {decision.conflict
                  ? 'This approval changed before your decision could be recorded.'
                  : decision.retryable
                    ? 'The decision could not reach the service. Your operation key is retained for a safe retry.'
                    : 'The decision could not be recorded.'}
              </p>
              {decision.conflict ? (
                <Button type="button" variant="outline" onClick={() => decision.reloadApproval()}>
                  Reload approval
                </Button>
              ) : decision.canRetryDecision ? (
                <Button type="button" variant="outline" onClick={() => decision.retryDecision()}>
                  Retry decision
                </Button>
              ) : null}
            </div>
          )}
        </section>
      )}
      {decision.successMessage !== '' && (
        <p
          ref={decision.statusRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="border-b py-5 text-sm font-medium text-primary"
        >
          {decision.successMessage}
        </p>
      )}
    </>
  );
}
