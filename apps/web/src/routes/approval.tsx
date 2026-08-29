import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  approvalBriefPayloadSchema,
  type ApprovalAction,
  type ApprovalDecisionRequest,
  type ApprovalDetailResponse,
  type DemoSession
} from '@slacato/contracts';
import type { LoaderFunctionArgs } from 'react-router';
import { AlertTriangle, ArrowLeft, CheckCircle2, FilePenLine, Gavel, XCircle } from 'lucide-react';
import { Link, useLoaderData, useNavigate, useRouteLoaderData } from 'react-router';
import { decideApproval } from '@/api/client';
import { csrfQueryOptions, queryClient, queryKeys, sessionQueryOptions, sessionRuntime, SessionInvalidatedError } from '@/api/session';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
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
  const navigate = useNavigate();
  const query = useQuery({ ...approvalDetailQueryOptions(session.version, initial.approvalSubjectId), initialData: initial });
  const detail = query.data;
  const [mode, setMode] = useState<'edit' | 'reject' | null>(null);
  const [rationale, setRationale] = useState('');
  const [editedPayload, setEditedPayload] = useState(() => JSON.stringify(detail.payload, null, 2));
  const operationKeys = useRef(new Map<ApprovalAction, string>());
  const decidedIds = useMemo(() => new Set(detail.entries.filter((entry) => entry.decided).map((entry) => entry.entryId)), [detail.entries]);
  const actionable = detail.entries.find((entry) => !entry.decided && entry.availableAuthority !== null
    && entry.dependsOn.every((dependency) => decidedIds.has(dependency)));
  const blocked = detail.entries.some((entry) => !entry.decided && entry.availableAuthority !== null) && actionable === undefined;

  const mutation = useMutation({
    mutationFn: async (action: ApprovalAction) => {
      if (actionable?.availableAuthority === null || actionable === undefined) throw new Error('No currently actionable approval entry');
      let payload: ApprovalDecisionRequest;
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
      if (action === 'edit_and_approve') {
        payload = { ...base, action, rationale: rationale.trim(), editedPayload: approvalBriefPayloadSchema.parse(JSON.parse(editedPayload) as unknown) };
      } else if (action === 'reject') {
        payload = { ...base, action, rationale: rationale.trim() };
      } else {
        payload = { ...base, action };
      }
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
      if (result.approvalSubjectId !== detail.approvalSubjectId) {
        await navigate(`/approvals/${encodeURIComponent(result.approvalSubjectId)}`, { replace: true });
        return;
      }
      setMode(null);
      setRationale('');
      operationKeys.current.clear();
      await query.refetch();
    }
  });
  const mutable = detail.status === 'awaiting_approval' && detail.supersededBySubjectId === null && actionable !== undefined;

  return (
    <article className="min-w-0" aria-labelledby="approval-title">
      <Button asChild variant="link" className="min-h-11 px-0"><Link to="/approvals"><ArrowLeft aria-hidden="true" />Back to approval inbox</Link></Button>
      <header className="mt-3 border-b pb-7">
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={detail.status === 'awaiting_approval' ? 'attention' : 'readonly'} label={detail.status === 'awaiting_approval' ? 'Approval review' : detail.status.replaceAll('_', ' ')} /><span className="text-xs text-muted-foreground">Quorum {detail.quorum.completed} of {detail.quorum.required}</span></div>
        <p className="mt-4 text-sm font-medium text-primary">{detail.opportunityId}</p>
        <h1 id="approval-title" className="mt-1 break-words text-3xl font-semibold tracking-tight sm:text-4xl">{detail.opportunityName}</h1>
        <p className="mt-3 text-muted-foreground">{detail.accountName} · Immutable review subject</p>
        <div className="mt-5 flex flex-wrap gap-2"><Button asChild variant="outline"><Link to={`/runs/${encodeURIComponent(detail.runId)}`}>View run</Link></Button><Button asChild variant="outline"><Link to={`/deals/${encodeURIComponent(detail.opportunityId)}`}>View deal</Link></Button></div>
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
          <SubjectSection title="Authorized evidence summaries">{detail.payload.sourceEvidence.evidence.length === 0 ? <p className="text-sm text-muted-foreground">No evidence summaries included.</p> : <ul className="grid gap-3">{detail.payload.sourceEvidence.evidence.map((evidence) => <li key={evidence.evidenceId}><p>{evidence.summary}</p><Button asChild variant="link" className="h-auto min-h-11 px-0"><Link to={`/deals/${encodeURIComponent(detail.opportunityId)}?evidence=${encodeURIComponent(evidence.evidenceId)}`}>Open authorized evidence</Link></Button></li>)}</ul>}</SubjectSection>
        </div>
      </section>

      {mutable && (
        <section className="border-b py-7" aria-labelledby="decision-title">
          <h2 id="decision-title" className="text-xl font-semibold">Record decision</h2>
          <p className="mt-2 text-sm text-muted-foreground">The decision uses the current run version and subject hash. A partial quorum remains awaiting approval.</p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate('approve_unchanged')}><CheckCircle2 aria-hidden="true" />Approve unchanged</Button>
            <Button type="button" variant="outline" disabled={mutation.isPending} aria-expanded={mode === 'edit'} onClick={() => setMode(mode === 'edit' ? null : 'edit')}><FilePenLine aria-hidden="true" />Edit and approve</Button>
            <Button type="button" variant="destructive" disabled={mutation.isPending} aria-expanded={mode === 'reject'} onClick={() => setMode(mode === 'reject' ? null : 'reject')}><XCircle aria-hidden="true" />Reject</Button>
          </div>
          {mode !== null && <div className="mt-5 grid gap-4 rounded-xl border bg-muted/30 p-5">
            {mode === 'edit' && <div className="grid gap-2"><Label htmlFor="edited-brief">Edited brief JSON</Label><Textarea id="edited-brief" className="min-h-72 font-mono text-xs" value={editedPayload} onChange={(event) => setEditedPayload(event.target.value)} /><p className="text-xs text-muted-foreground">Citation identifiers and bindings are immutable. Saving this edit creates a new subject and never resumes the run by itself.</p></div>}
            <div className="grid gap-2"><Label htmlFor="decision-rationale">Rationale</Label><Textarea id="decision-rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder={mode === 'reject' ? 'Explain why this brief cannot proceed' : 'Explain the approved edit'} /></div>
            <Button type="button" disabled={mutation.isPending || rationale.trim().length === 0} onClick={() => mutation.mutate(mode === 'edit' ? 'edit_and_approve' : 'reject')}><Gavel aria-hidden="true" />{mutation.isPending ? 'Recording decision…' : mode === 'edit' ? 'Submit edit for approval' : 'Confirm rejection'}</Button>
          </div>}
          {mutation.isError && <p role="alert" className="mt-4 text-sm text-destructive">The decision was not recorded. The approval may have changed; refresh for canonical state or safely retry the same operation.</p>}
        </section>
      )}

      <section className="py-7" aria-labelledby="history-title"><h2 id="history-title" className="text-xl font-semibold">Decision history</h2>{detail.decisions.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No decisions recorded yet.</p> : <ol className="mt-4 grid gap-3">{detail.decisions.map((decision) => <li key={`${decision.decidedAt}:${decision.actorName}`} className="rounded-lg border p-4"><div className="flex flex-wrap items-center gap-2"><StatusBadge status={decision.action === 'reject' ? 'attention' : 'ready'} label={label(decision.action)} /><span className="text-sm font-medium">{decision.actorName}</span></div><p className="mt-2 text-sm text-muted-foreground">{label(decision.authority)} · <time dateTime={decision.decidedAt}>{formatTime(decision.decidedAt)}</time>{decision.changed ? ' · Subject changed' : ''}</p>{decision.rationale && <p className="mt-3 text-sm leading-6">{decision.rationale}</p>}</li>)}</ol>}</section>
    </article>
  );
}

function SubjectSection({ title, children }: Readonly<{ title: string; children: React.ReactNode }>): React.JSX.Element { return <section className="rounded-xl border bg-card p-5"><h3 className="font-semibold">{title}</h3><div className="mt-3">{children}</div></section>; }
function operationKey(keys: Map<ApprovalAction, string>, action: ApprovalAction): string { const existing = keys.get(action); if (existing !== undefined) return existing; const created = crypto.randomUUID(); keys.set(action, created); return created; }
function label(value: string): string { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
