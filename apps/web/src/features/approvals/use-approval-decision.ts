import {
  type ApprovalAction,
  type ApprovalBriefPayload,
  type ApprovalDecisionRequest,
  type ApprovalDetailResponse,
  approvalBriefPayloadSchema,
  type DemoSession
} from '@slacato/contracts';
import { useMutation } from '@tanstack/react-query';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ApiError, decideApproval } from '@/api/client';
import { csrfQueryOptions, queryClient, queryKeys } from '@/api/session';

/** A single before/after row surfaced in the edit-and-approve change preview. */
export interface ApprovalPreviewField {
  label: string;
  before: string;
  after: string;
}

/** State, derived values, and actions backing the approval decision form. */
export interface UseApprovalDecisionResult {
  mode: 'edit' | 'reject' | null;
  setMode: (mode: 'edit' | 'reject' | null) => void;
  rationale: string;
  setRationale: (value: string) => void;
  executiveSummary: string;
  setExecutiveSummary: (value: string) => void;
  negotiationState: string;
  setNegotiationState: (value: string) => void;
  confidence: string;
  setConfidence: (value: string) => void;
  fieldErrors: Record<string, string>;
  activeAction: ApprovalAction | null;
  successMessage: string;
  executiveSummaryRef: RefObject<HTMLTextAreaElement | null>;
  negotiationStateRef: RefObject<HTMLTextAreaElement | null>;
  confidenceRef: RefObject<HTMLInputElement | null>;
  rationaleRef: RefObject<HTMLTextAreaElement | null>;
  statusRef: RefObject<HTMLParagraphElement | null>;
  evidenceIds: ReadonlySet<string>;
  actionable: ApprovalDetailResponse['entries'][number] | undefined;
  blocked: boolean;
  mutable: boolean;
  preview: readonly ApprovalPreviewField[];
  isPending: boolean;
  isError: boolean;
  conflict: boolean;
  retryable: boolean;
  canRetryDecision: boolean;
  submit: (action: ApprovalAction) => void;
  reloadApproval: () => void;
  retryDecision: () => void;
}

/** Owns the edit/decision state machine and mutation orchestration for one approval subject. */
export function useApprovalDecision(
  detail: ApprovalDetailResponse,
  session: DemoSession,
  refetch: () => Promise<unknown>
): UseApprovalDecisionResult {
  const location = useLocation();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'edit' | 'reject' | null>(null);
  const [rationale, setRationale] = useState('');
  const [executiveSummary, setExecutiveSummary] = useState(
    detail.payload.executiveSummary.narrative
  );
  const [negotiationState, setNegotiationState] = useState(
    detail.payload.negotiationState.currentState
  );
  const [confidence, setConfidence] = useState(
    String(detail.payload.confidenceAndReviewWarnings.overallConfidence)
  );
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
  const evidenceIds = useMemo(
    () => new Set(detail.capabilities.evidenceIds),
    [detail.capabilities.evidenceIds]
  );
  const decidedIds = useMemo(
    () => new Set(detail.entries.filter((entry) => entry.decided).map((entry) => entry.entryId)),
    [detail.entries]
  );
  const actionable = detail.entries.find(
    (entry) =>
      !entry.decided &&
      entry.availableAuthority !== null &&
      entry.dependsOn.every((dependency) => decidedIds.has(dependency))
  );
  const blocked =
    detail.entries.some((entry) => !entry.decided && entry.availableAuthority !== null) &&
    actionable === undefined;
  const confidenceValue = useMemo(() => {
    const trimmed = confidence.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  }, [confidence]);
  const editedPayload = useMemo(
    (): ApprovalBriefPayload | null =>
      confidenceValue === null
        ? null
        : {
            ...detail.payload,
            executiveSummary: { ...detail.payload.executiveSummary, narrative: executiveSummary },
            negotiationState: {
              ...detail.payload.negotiationState,
              currentState: negotiationState
            },
            confidenceAndReviewWarnings: {
              ...detail.payload.confidenceAndReviewWarnings,
              overallConfidence: confidenceValue
            }
          },
    [confidenceValue, detail.payload, executiveSummary, negotiationState]
  );
  const preview = useMemo(
    () =>
      [
        {
          label: 'Executive summary',
          before: detail.payload.executiveSummary.narrative,
          after: executiveSummary
        },
        {
          label: 'Negotiation state',
          before: detail.payload.negotiationState.currentState,
          after: negotiationState
        },
        {
          label: 'Overall confidence',
          before: String(detail.payload.confidenceAndReviewWarnings.overallConfidence),
          after: confidenceValue === null ? 'No valid value entered' : String(confidenceValue)
        }
      ].filter((field) => field.before !== field.after),
    [confidenceValue, detail.payload, executiveSummary, negotiationState]
  );

  useEffect(() => {
    if (successMessage !== '') statusRef.current?.focus();
  }, [successMessage]);

  const mutation = useMutation({
    mutationFn: async (payload: ApprovalDecisionRequest) => {
      const csrfToken = await queryClient.ensureQueryData(csrfQueryOptions(session.version));
      return decideApproval(payload, csrfToken);
    },
    onSuccess: async (result) => {
      const recordedMessage =
        result.status === 'rejected'
          ? 'Decision recorded. The run was rejected.'
          : result.quorumSatisfied
            ? 'Decision recorded. Approval quorum is satisfied.'
            : `Decision recorded. ${detail.quorum.completed + 1} of ${detail.quorum.required} approvals are complete; the run remains awaiting approval.`;
      setSuccessMessage(recordedMessage);
      setActiveAction(null);
      if (result.approvalSubjectId !== detail.approvalSubjectId) {
        await navigate(`/approvals/${encodeURIComponent(result.approvalSubjectId)}`, {
          replace: true,
          state: { approvalSuccess: recordedMessage, focusOwner: 'approval-status' }
        });
      } else {
        setMode(null);
        setRationale('');
        operationKeys.current.clear();
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, 'approvals') }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.scoped(session.version, `approval:${result.approvalSubjectId}`)
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.scoped(session.version, `run:${detail.runId}`)
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, 'runs') }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.scoped(session.version, `deal:${detail.opportunityId}`)
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(session.version, 'deals') })
      ]);
      if (result.approvalSubjectId === detail.approvalSubjectId) await refetch();
    },
    onError: () => setActiveAction(null)
  });
  const mutable =
    detail.status === 'awaiting_approval' &&
    detail.supersededBySubjectId === null &&
    actionable !== undefined;

  /** Validates and submits the selected approval action. */
  function submit(action: ApprovalAction): void {
    if (actionable?.availableAuthority === null || actionable === undefined) return;
    const errors: Record<string, string> = {};
    const trimmedRationale = rationale.trim();
    if (action !== 'approve_unchanged' && trimmedRationale.length === 0)
      errors.rationale = 'Enter a rationale.';
    if (trimmedRationale.length > 4_000)
      errors.rationale = 'Rationale must be 4,000 characters or fewer.';
    if (action === 'edit_and_approve') {
      if (executiveSummary.trim().length === 0)
        errors.executiveSummary = 'Enter an executive summary.';
      else if (executiveSummary.length > 8_000)
        errors.executiveSummary = 'Executive summary must be 8,000 characters or fewer.';
      if (negotiationState.trim().length === 0)
        errors.negotiationState = 'Enter the negotiation state.';
      else if (negotiationState.length > 8_000)
        errors.negotiationState = 'Negotiation state must be 8,000 characters or fewer.';
      if (confidenceValue === null) errors.confidence = 'Enter a confidence value from 0 to 1.';
      if (editedPayload !== null) {
        const parsed = approvalBriefPayloadSchema.safeParse(editedPayload);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            const section = issue.path[0];
            if (section === 'executiveSummary')
              errors.executiveSummary ??=
                'Review the executive summary and keep it within 8,000 characters.';
            else if (section === 'negotiationState')
              errors.negotiationState ??=
                'Review the negotiation state and keep it within 8,000 characters.';
            else if (section === 'confidenceAndReviewWarnings')
              errors.confidence ??= 'Enter a confidence value from 0 to 1.';
            else
              errors.editedPayload ??= 'The edited brief does not satisfy the approval contract.';
          }
        }
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      window.requestAnimationFrame(() => {
        if (errors.executiveSummary) executiveSummaryRef.current?.focus();
        else if (errors.negotiationState) negotiationStateRef.current?.focus();
        else if (errors.confidence || errors.editedPayload) confidenceRef.current?.focus();
        else rationaleRef.current?.focus();
      });
      return;
    }
    if (action === 'edit_and_approve' && editedPayload === null) return;
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
    const payload: ApprovalDecisionRequest =
      action === 'edit_and_approve'
        ? {
            ...base,
            action,
            rationale: trimmedRationale,
            editedPayload: approvalBriefPayloadSchema.parse(editedPayload)
          }
        : action === 'reject'
          ? { ...base, action, rationale: trimmedRationale }
          : { ...base, action };
    setSuccessMessage('');
    setActiveAction(action);
    mutation.mutate(payload);
  }

  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
  const retryable =
    mutation.isError &&
    !conflict &&
    (!(mutation.error instanceof ApiError) || mutation.error.status >= 500);

  /** Clears pending operation keys and reloads the approval after a version conflict. */
  function reloadApproval(): void {
    operationKeys.current.clear();
    mutation.reset();
    void refetch();
  }

  /** Retries the most recently attempted decision using its retained idempotency key. */
  function retryDecision(): void {
    if (mutation.variables === undefined) return;
    setActiveAction(mutation.variables.action);
    mutation.mutate(mutation.variables);
  }

  return {
    mode,
    setMode,
    rationale,
    setRationale,
    executiveSummary,
    setExecutiveSummary,
    negotiationState,
    setNegotiationState,
    confidence,
    setConfidence,
    fieldErrors,
    activeAction,
    successMessage,
    executiveSummaryRef,
    negotiationStateRef,
    confidenceRef,
    rationaleRef,
    statusRef,
    evidenceIds,
    actionable,
    blocked,
    mutable,
    preview,
    isPending: mutation.isPending,
    isError: mutation.isError,
    conflict,
    retryable,
    canRetryDecision: retryable && mutation.variables !== undefined,
    submit,
    reloadApproval,
    retryDecision
  };
}

/** Reuses one idempotency key for repeated attempts at the same approval action. */
function operationKey(keys: Map<ApprovalAction, string>, action: ApprovalAction): string {
  const existing = keys.get(action);
  if (existing !== undefined) return existing;
  const created = crypto.randomUUID();
  keys.set(action, created);
  return created;
}
