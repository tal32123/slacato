import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  approvalBriefPayloadSchema,
  type ApprovalAction,
  type ApprovalBriefPayload,
  type ApprovalDecisionRequest,
  type ApprovalDetailResponse,
  type DemoSession
} from '@slacato/contracts';
import type { LoaderFunctionArgs } from 'react-router';
import { AlertTriangle, ArrowLeft, CheckCircle2, FilePenLine, Gavel, XCircle } from 'lucide-react';
import { Link, useLoaderData, useLocation, useNavigate, useRouteLoaderData } from 'react-router';
import { ApiError, decideApproval } from '@/api/client';
import { csrfQueryOptions, queryClient, queryKeys, sessionQueryOptions, sessionRuntime, SessionInvalidatedError } from '@/api/session';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { approvalDetailQueryOptions } from '@/features/approvals/queries';
import { throwProtectedLoaderError } from './loader-security';

export async function approvalLoader({ request, params }: LoaderFunctionArgs): Promise<ApprovalDetailResponse | null> {
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
          const response = await queryClient.fetchQuery(approvalDetailQueryOptions(session.version, subjectId));
          sessionRuntime.finishTransition();
          return response;
        }
      } catch (retryError) { throwProtectedLoaderError(retryError, request); }
    }
    throwProtectedLoaderError(error, request);
  }
}

export function ApprovalRoute(): React.JSX.Element {
  const initial = useLoaderData() as ApprovalDetailResponse;
  const session = useRouteLoaderData('protected-root') as DemoSession;
  const query = useQuery({ ...approvalDetailQueryOptions(session.version, initial.approvalSubjectId), initialData: initial });
  return <ApprovalDecisionPage key={query.data.approvalSubjectId} detail={query.data} session={session} refetch={() => query.refetch()} />;
}

function ApprovalDecisionPage({ detail, session, refetch }: Readonly<{
  detail: ApprovalDetailResponse;
  session: DemoSession;
  refetch: () => Promise<unknown>;
}>): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'edit' | 'reject' | null>(null);
  const [rationale, setRationale] = useState('');
  const [executiveSummary, setExecutiveSummary] = useState(detail.payload.executiveSummary.narrative);
  const [negotiationState, setNegotiationState] = useState(detail.payload.negotiationState.currentState);
  const [confidence, setConfidence] = useState(String(detail.payload.confidenceAndReviewWarnings.overallConfidence));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const executiveSummaryRef = useRef<HTMLTextAreaElement>(null);
  const negotiationStateRef = useRef<HTMLTextAreaElement>(null);
  const confidenceRef = useRef<HTMLInputElement>(null);
  const rationaleRef = useRef<HTMLTextAreaElement>(null);
  const [activeAction, setActiveAction] = useState<ApprovalAction | null>(null);
  const [successMessage, setSuccessMessage] = useState(() => {
    const state = location.state as { approvalSuccess?: unknown } | null;
    return typeof state?.approvalSuccess === 'string' ? state.approvalSuccess : '';
  });
  const operationKeys = useRef(new Map<ApprovalAction, string>());
  const statusRef = useRef<HTMLParagraphElement>(null);
  const evidenceIds = useMemo(() => new Set(detail.capabilities.evidenceIds), [detail.capabilities.evidenceIds]);
  const decidedIds = useMemo(() => new Set(detail.entries.filter((entry) => entry.decided).map((entry) => entry.entryId)), [detail.entries]);
  const actionable = detail.entries.find((entry) => !entry.decided && entry.availableAuthority !== null
    && entry.dependsOn.every((dependency) => decidedIds.has(dependency)));
  const blocked = detail.entries.some((entry) => !entry.decided && entry.availableAuthority !== null) && actionable === undefined;
  const editedPayload = useMemo((): ApprovalBriefPayload => ({
    ...detail.payload,
    executiveSummary: { ...detail.payload.executiveSummary, narrative: executiveSummary },
    negotiationState: { ...detail.payload.negotiationState, currentState: negotiationState },
    confidenceAndReviewWarnings: {
      ...detail.payload.confidenceAndReviewWarnings,
      overallConfidence: Number(confidence)
    }
  }), [confidence, detail.payload, executiveSummary, negotiationState]);
  const preview = useMemo(() => [
    { label: 'Executive summary', before: detail.payload.executiveSummary.narrative, after: executiveSummary },
    { label: 'Negotiation state', before: detail.payload.negotiationState.currentState, after: negotiationState },
    { label: 'Overall confidence', before: String(detail.payload.confidenceAndReviewWarnings.overallConfidence), after: confidence }
  ].filter((field) => field.before !== field.after), [confidence, detail.payload, executiveSummary, negotiationState]);

  useEffect(() => {
    if (successMessage !== '') statusRef.current?.focus();
  }, [successMessage]);

  const mutation = useMutation({
    mutationFn: async (payload: ApprovalDecisionRequest) => {
      const csrfToken = await queryClient.ensureQueryData(csrfQueryOptions(session.version));
      return decideApproval(payload, csrfToken);
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, 'approvals') }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, `approval:${detail.approvalSubjectId}`) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, `run:${detail.runId}`) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, 'runs') }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, `deal:${detail.opportunityId}`) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, 'deals') })
      ]);
      const recordedMessage = result.quorumSatisfied
        ? 'Decision recorded. Approval quorum is satisfied.'
        : `Decision recorded. ${detail.quorum.completed + 1} of ${detail.quorum.required} approvals are complete; the run remains awaiting approval.`;
      setSuccessMessage(recordedMessage);
      setActiveAction(null);
      if (result.approvalSubjectId !== detail.approvalSubjectId) {
        await navigate(`/approvals/${encodeURIComponent(result.approvalSubjectId)}`, {
          replace: true,
          state: { approvalSuccess: recordedMessage }
        });
        return;
      }
      setMode(null);
      setRationale('');
      operationKeys.current.clear();
      await refetch();
    },
    onError: () => setActiveAction(null)
  });
  const mutable = detail.status === 'awaiting_approval' && detail.supersededBySubjectId === null && actionable !== undefined;

  function submit(action: ApprovalAction): void {
    if (actionable?.availableAuthority === null || actionable === undefined) return;
    const errors: Record<string, string> = {};
    const trimmedRationale = rationale.trim();
    if (action !== 'approve_unchanged' && trimmedRationale.length === 0) errors.rationale = 'Enter a rationale.';
    if (trimmedRationale.length > 4_000) errors.rationale = 'Rationale must be 4,000 characters or fewer.';
    if (action === 'edit_and_approve') {
      if (executiveSummary.trim().length === 0) errors.executiveSummary = 'Enter an executive summary.';
      if (negotiationState.trim().length === 0) errors.negotiationState = 'Enter the negotiation state.';
      const parsed = approvalBriefPayloadSchema.safeParse(editedPayload);
      if (!parsed.success) errors.editedPayload = 'Review the edited fields. Text and confidence must stay within the permitted contract.';
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      window.requestAnimationFrame(() => {
        if (errors.executiveSummary) executiveSummaryRef.current?.focus();
        else if (errors.negotiationState) negotiationStateRef.current?.focus();
        else if (errors.editedPayload) confidenceRef.current?.focus();
        else rationaleRef.current?.focus();
      });
      return;
    }
    const base = {
      runId: detail.runId,
      approvalSubjectId: detail.approvalSubjectId,
      expectedRunVersion: detail.runVersion,
      expectedSubjectHash: detail.subjectHash,
      entryId: actionable.entryId,
      category: actionable.category,
      authority: actionable.availableAuthority,
      idempotencyKey: operationKey(operationKeys.current, action)
    } as const;
    const payload: ApprovalDecisionRequest = action === 'edit_and_approve'
      ? { ...base, action, rationale: trimmedRationale, editedPayload: approvalBriefPayloadSchema.parse(editedPayload) }
      : action === 'reject'
        ? { ...base, action, rationale: trimmedRationale }
        : { ...base, action };
    setSuccessMessage('');
    setActiveAction(action);
    mutation.mutate(payload);
  }

  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
  const retryable = mutation.isError && !conflict && (!(mutation.error instanceof ApiError) || mutation.error.status >= 500);
  return (
    <article className="min-w-0" aria-labelledby="approval-title">
      <Button asChild variant="link" className="min-h-11 px-0"><Link to="/approvals"><ArrowLeft aria-hidden="true" />Back to approval inbox</Link></Button>
      <header className="mt-3 border-b pb-7">
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={detail.status === 'awaiting_approval' ? 'attention' : 'readonly'} label={detail.status === 'awaiting_approval' ? 'Approval review' : label(detail.status)} /><span className="text-xs text-muted-foreground">Quorum {detail.quorum.completed} of {detail.quorum.required}</span></div>
        <p className="mt-4 text-sm font-medium text-primary">{detail.opportunityId}</p>
        <h1 id="approval-title" className="mt-1 break-words text-3xl font-semibold tracking-tight sm:text-4xl">{detail.opportunityName}</h1>
        <p className="mt-3 text-muted-foreground">{detail.accountName} · Immutable review subject</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild variant="outline"><Link to={`/runs/${encodeURIComponent(detail.runId)}`}>View run</Link></Button>
          {detail.capabilities.canReadDeal && <Button asChild variant="outline"><Link to={`/deals/${encodeURIComponent(detail.opportunityId)}`}>View deal</Link></Button>}
        </div>
      </header>

      {detail.supersededBySubjectId !== null && <aside className="mt-6 rounded-xl border border-attention bg-attention/10 p-5"><h2 className="font-semibold">This subject was replaced by an approved edit</h2><p className="mt-1 text-sm text-muted-foreground">Decisions against this immutable snapshot are closed.</p><Button asChild className="mt-4"><Link to={`/approvals/${encodeURIComponent(detail.supersededBySubjectId)}`}>Open current subject</Link></Button></aside>}
      {blocked && <aside className="mt-6 flex items-start gap-3 rounded-xl border border-attention bg-attention/10 p-5"><AlertTriangle aria-hidden="true" className="mt-0.5 size-5 text-attention-foreground" /><div><h2 className="font-semibold">Waiting on an underlying approval</h2><p className="mt-1 text-sm text-muted-foreground">Your authority can operate a later entry after its dependency is satisfied. Editing alone never advances the run.</p></div></aside>}

      <section className="border-b py-7" aria-labelledby="requirements-title">
        <h2 id="requirements-title" className="text-xl font-semibold">Required approvals</h2>
        <ul className="mt-4 grid gap-3">{detail.entries.map((entry) => <li key={entry.entryId} className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><div><p className="font-medium">{label(entry.category)}</p><p className="mt-1 text-sm text-muted-foreground">Required: {entry.requiredAuthorities.map(label).join(' or ')}</p>{entry.dependsOn.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Depends on {entry.dependsOn.join(', ')}</p>}</div><StatusBadge status={entry.decided ? 'ready' : entry.availableAuthority !== null ? 'attention' : 'readonly'} label={entry.decided ? 'Decided' : entry.availableAuthority !== null ? `Your authority: ${label(entry.availableAuthority)}` : 'Not your authority'} /></li>)}</ul>
      </section>

      <section className="border-b py-7" aria-labelledby="subject-title">
        <h2 id="subject-title" className="text-xl font-semibold">Validated brief under review</h2>
        <div className="mt-5 grid gap-5">
          <SubjectSection title="Executive summary"><p className="leading-7">{detail.payload.executiveSummary.narrative}</p></SubjectSection>
          <SubjectSection title="Negotiation state"><p className="leading-7">{detail.payload.negotiationState.currentState}</p>{detail.payload.negotiationState.risks.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm">{detail.payload.negotiationState.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>}</SubjectSection>
          <SubjectSection title="Recommended next actions">{detail.payload.recommendedNextActions.actions.length === 0 ? <p className="text-sm text-muted-foreground">No actions proposed.</p> : <ul className="grid gap-2">{detail.payload.recommendedNextActions.actions.map((action) => <li key={action.action}>{action.action}</li>)}</ul>}</SubjectSection>
          <SubjectSection title="Authorized evidence summaries">{detail.payload.sourceEvidence.evidence.length === 0 ? <p className="text-sm text-muted-foreground">No evidence summaries included.</p> : <ul className="grid gap-3">{detail.payload.sourceEvidence.evidence.map((evidence) => <li key={evidence.evidenceId}><p>{evidence.summary}</p>{evidenceIds.has(evidence.evidenceId) && <Button asChild variant="link" className="h-auto min-h-11 px-0"><Link to={`/deals/${encodeURIComponent(detail.opportunityId)}?evidence=${encodeURIComponent(evidence.evidenceId)}`}>Open authorized evidence</Link></Button>}</li>)}</ul>}</SubjectSection>
        </div>
      </section>

      {mutable && (
        <section className="border-b py-7" aria-labelledby="decision-title" aria-busy={mutation.isPending}>
          <h2 id="decision-title" className="text-xl font-semibold">Record decision</h2>
          <p className="mt-2 text-sm text-muted-foreground">The decision uses the current run version and subject hash. A partial quorum remains awaiting approval.</p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button type="button" disabled={mutation.isPending} onClick={() => submit('approve_unchanged')}><CheckCircle2 aria-hidden="true" />{activeAction === 'approve_unchanged' ? 'Recording approval…' : 'Approve unchanged'}</Button>
            <Button type="button" variant="outline" disabled={mutation.isPending} aria-expanded={mode === 'edit'} aria-controls="edit-decision-fields" onClick={() => setMode(mode === 'edit' ? null : 'edit')}><FilePenLine aria-hidden="true" />Edit and approve</Button>
            <Button type="button" variant="destructive" disabled={mutation.isPending} aria-expanded={mode === 'reject'} aria-controls="reject-decision-fields" onClick={() => setMode(mode === 'reject' ? null : 'reject')}><XCircle aria-hidden="true" />Reject</Button>
          </div>
          {mode !== null && <div id={mode === 'edit' ? 'edit-decision-fields' : 'reject-decision-fields'} className="mt-5 grid gap-5 rounded-xl border bg-muted/30 p-5">
            {mode === 'edit' && <>
              <div className="grid gap-2"><Label htmlFor="executive-summary">Executive summary</Label><Textarea ref={executiveSummaryRef} id="executive-summary" value={executiveSummary} aria-invalid={fieldErrors.executiveSummary ? true : undefined} aria-describedby={fieldErrors.executiveSummary ? 'executive-summary-error' : undefined} onChange={(event) => setExecutiveSummary(event.target.value)} />{fieldErrors.executiveSummary && <p id="executive-summary-error" className="text-sm text-destructive">{fieldErrors.executiveSummary}</p>}</div>
              <div className="grid gap-2"><Label htmlFor="negotiation-state">Negotiation state</Label><Textarea ref={negotiationStateRef} id="negotiation-state" value={negotiationState} aria-invalid={fieldErrors.negotiationState ? true : undefined} aria-describedby={fieldErrors.negotiationState ? 'negotiation-state-error' : undefined} onChange={(event) => setNegotiationState(event.target.value)} />{fieldErrors.negotiationState && <p id="negotiation-state-error" className="text-sm text-destructive">{fieldErrors.negotiationState}</p>}</div>
              <div className="grid max-w-xs gap-2"><Label htmlFor="overall-confidence">Overall confidence</Label><Input ref={confidenceRef} id="overall-confidence" type="number" min="0" max="1" step="0.01" value={confidence} aria-invalid={fieldErrors.editedPayload ? true : undefined} aria-describedby={fieldErrors.editedPayload ? 'edited-payload-error' : undefined} onChange={(event) => setConfidence(event.target.value)} />{fieldErrors.editedPayload && <p id="edited-payload-error" className="text-sm text-destructive">{fieldErrors.editedPayload}</p>}</div>
              <section aria-labelledby="change-preview-title" className="rounded-lg border bg-card p-4"><h3 id="change-preview-title" className="font-semibold">Change preview</h3>{preview.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No review fields have changed.</p> : <dl className="mt-3 grid gap-4">{preview.map((field) => <div key={field.label}><dt className="font-medium">{field.label}</dt><dd className="mt-1 grid gap-2 text-sm sm:grid-cols-2"><span className="rounded border p-3"><strong className="block text-xs uppercase text-muted-foreground">Before</strong>{field.before}</span><span className="rounded border p-3"><strong className="block text-xs uppercase text-muted-foreground">After</strong>{field.after}</span></dd></div>)}</dl>}<p className="mt-4 text-sm text-muted-foreground">This decision completes {Math.min(detail.quorum.completed + 1, detail.quorum.required)} of {detail.quorum.required} approvals. Editing creates a new immutable subject and never resumes the run by itself.</p></section>
            </>}
            <div className="grid gap-2"><Label htmlFor="decision-rationale">Rationale</Label><Textarea ref={rationaleRef} id="decision-rationale" maxLength={4000} value={rationale} aria-invalid={fieldErrors.rationale ? true : undefined} aria-describedby={fieldErrors.rationale ? 'decision-rationale-error decision-rationale-help' : 'decision-rationale-help'} onChange={(event) => setRationale(event.target.value)} placeholder={mode === 'reject' ? 'Explain why this brief cannot proceed' : 'Explain the approved edit'} /><p id="decision-rationale-help" className="text-xs text-muted-foreground">{rationale.length} of 4,000 characters</p>{fieldErrors.rationale && <p id="decision-rationale-error" className="text-sm text-destructive">{fieldErrors.rationale}</p>}</div>
            <Button type="button" disabled={mutation.isPending} onClick={() => submit(mode === 'edit' ? 'edit_and_approve' : 'reject')}><Gavel aria-hidden="true" />{activeAction !== null ? 'Recording decision…' : mode === 'edit' ? 'Submit edit for approval' : 'Confirm rejection'}</Button>
          </div>}
          {successMessage !== '' && <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" className="mt-4 text-sm text-primary">{successMessage}</p>}
          {mutation.isError && <div role="alert" className="mt-4 grid justify-items-start gap-2 text-sm text-destructive"><p>{conflict ? 'This approval changed before your decision could be recorded.' : retryable ? 'The decision could not reach the service. Your operation key is retained for a safe retry.' : 'The decision could not be recorded.'}</p>{conflict ? <Button type="button" variant="outline" onClick={() => { operationKeys.current.clear(); mutation.reset(); void refetch(); }}>Reload approval</Button> : retryable && mutation.variables ? <Button type="button" variant="outline" onClick={() => { setActiveAction(mutation.variables.action); mutation.mutate(mutation.variables); }}>Retry decision</Button> : null}</div>}
        </section>
      )}

      <section className="py-7" aria-labelledby="history-title"><h2 id="history-title" className="text-xl font-semibold">Decision history</h2>{detail.decisions.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No decisions recorded yet.</p> : <ol className="mt-4 grid gap-3">{detail.decisions.map((decision) => <li key={`${decision.decidedAt}:${decision.actorName}`} className="rounded-lg border p-4"><div className="flex flex-wrap items-center gap-2"><StatusBadge status={decision.action === 'reject' ? 'attention' : 'ready'} label={label(decision.action)} /><span className="text-sm font-medium">{decision.actorName}</span></div><p className="mt-2 text-sm text-muted-foreground">{label(decision.authority)} · <time dateTime={decision.decidedAt}>{formatTime(decision.decidedAt)}</time>{decision.changed ? ' · Subject changed' : ''}</p>{decision.rationale && <p className="mt-3 text-sm leading-6">{decision.rationale}</p>}{decision.diff && <div className="mt-4 rounded-lg bg-muted/50 p-4"><p className="text-sm font-medium">Recorded changes</p>{decision.diff.fields.length > 0 && <dl className="mt-2 grid gap-3">{decision.diff.fields.map((field) => <div key={field.field}><dt className="text-xs font-medium uppercase text-muted-foreground">{label(field.field)}</dt><dd className="mt-1 text-sm"><span className="line-through">{field.before}</span> → {field.after}</dd></div>)}</dl>}<p className="mt-3 text-xs text-muted-foreground">Sections changed: {decision.diff.changedSections.map(label).join(', ') || 'None'}</p></div>}</li>)}</ol>}</section>
    </article>
  );
}

function SubjectSection({ title, children }: Readonly<{ title: string; children: React.ReactNode }>): React.JSX.Element { return <section className="rounded-xl border bg-card p-5"><h3 className="font-semibold">{title}</h3><div className="mt-3">{children}</div></section>; }
function operationKey(keys: Map<ApprovalAction, string>, action: ApprovalAction): string { const existing = keys.get(action); if (existing !== undefined) return existing; const created = crypto.randomUUID(); keys.set(action, created); return created; }
function label(value: string): string { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
