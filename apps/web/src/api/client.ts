import {
  type ApprovalDecisionRequest,
  type ApprovalDecisionResult,
  type ApprovalDetailResponse,
  type ApprovalInboxResponse,
  type AuthSessionResponse,
  approvalDecisionRequestSchema,
  approvalDecisionResultSchema,
  approvalDetailResponseSchema,
  approvalInboxResponseSchema,
  authErrorResponseSchema,
  authenticatedMutationResponseSchema,
  authSessionResponseSchema,
  type CancelRunResponse,
  cancelRunResponseSchema,
  csrfResponseSchema,
  type DealListResponse,
  type DealWorkspaceView,
  type DemoDiagnosticsResponse,
  dealListResponseSchema,
  dealWorkspaceViewSchema,
  demoDiagnosticsResponseSchema,
  logoutResponseSchema,
  type Persona,
  personaListResponseSchema,
  type ReadinessHealth,
  type RunDetailResponse,
  type RunListResponse,
  readinessHealthSchema,
  runDetailResponseSchema,
  runListResponseSchema,
  type StartBriefRequest,
  type StartBriefResponse,
  startBriefRequestSchema,
  startBriefResponseSchema
} from '@slacato/contracts';

interface WireSchema<T> {
  parse(input: unknown): T;
}

/** Represents a failed API request with the status and safe error code the interface can act on. */
export class ApiError extends Error {
  /** Creates a client-safe API failure from the server response status and error code. */
  public constructor(
    public readonly status: number,
    public readonly code?: 'UNAUTHORIZED' | 'FORBIDDEN' | 'INVALID_CSRF'
  ) {
    super(status === 401 ? 'Authentication is required.' : 'The request could not be completed.');
  }
}

/** Sends a credentialed API request and validates its successful response against the expected contract. */
export async function requestJson<T>(
  schema: WireSchema<T>,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch((): undefined => undefined);
    const parsed = authErrorResponseSchema.safeParse(body);
    throw new ApiError(response.status, parsed.success ? parsed.data.code : undefined);
  }
  return schema.parse(await response.json());
}

/** Loads the current signed-in session for the interface. */
export function fetchSession(signal?: AbortSignal): Promise<AuthSessionResponse> {
  return requestJson(authSessionResponseSchema, '/api/auth/session', { signal });
}

/** Loads the personas the current user may select. */
export async function fetchPersonas(signal?: AbortSignal): Promise<readonly Persona[]> {
  return (await requestJson(personaListResponseSchema, '/api/auth/personas', { signal })).personas;
}

/** Loads a fresh CSRF token for protected actions. */
export async function fetchCsrf(signal?: AbortSignal): Promise<string> {
  return (await requestJson(csrfResponseSchema, '/api/auth/csrf', { signal })).csrfToken;
}

/** Switches the active persona and returns the resulting authenticated session. */
export function changePersona(userId: string, csrfToken: string) {
  return requestJson(authenticatedMutationResponseSchema, '/api/auth/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ userId })
  });
}

/** Ends the active session and returns the resulting signed-out state. */
export function endSession(csrfToken: string) {
  return requestJson(logoutResponseSchema, '/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: '{}'
  });
}

/**
 * Loads whether the dependencies brief generation needs are ready to serve traffic.
 * Reads the response body regardless of HTTP status, because a "not ready" result is
 * reported with a 503 that still carries the shaped readiness payload.
 */
export async function fetchReadiness(signal?: AbortSignal): Promise<ReadinessHealth> {
  const response = await fetch('/api/health/ready', { signal });
  const body = await response.json().catch((): undefined => undefined);
  return readinessHealthSchema.parse(body);
}

/** Loads demo diagnostics for the active session. */
export function fetchDiagnostics(
  signal: AbortSignal | undefined
): Promise<DemoDiagnosticsResponse> {
  return requestJson(demoDiagnosticsResponseSchema, '/api/diagnostics', { signal });
}

/** Loads the deals visible to the active persona. */
export function fetchDeals(signal: AbortSignal | undefined): Promise<DealListResponse> {
  return requestJson(dealListResponseSchema, '/api/deals', { signal });
}

/** Loads the authorized workspace for a selected deal. */
export function fetchDealWorkspace(
  opportunityId: string,
  signal: AbortSignal | undefined
): Promise<DealWorkspaceView> {
  return requestJson(dealWorkspaceViewSchema, `/api/deals/${encodeURIComponent(opportunityId)}`, {
    signal
  });
}

/** Loads the brief-generation runs visible to the active persona. */
export function fetchRuns(signal: AbortSignal | undefined): Promise<RunListResponse> {
  return requestJson(runListResponseSchema, '/api/runs', { signal });
}

/** Loads the latest detail for a selected brief-generation run. */
export function fetchRunDetail(
  runId: string,
  signal: AbortSignal | undefined
): Promise<RunDetailResponse> {
  return requestJson(runDetailResponseSchema, `/api/runs/${encodeURIComponent(runId)}/detail`, {
    signal
  });
}

/** Starts a source-backed brief-generation run for a deal. */
export function startBrief(
  input: StartBriefRequest,
  csrfToken: string
): Promise<StartBriefResponse> {
  return requestJson(startBriefResponseSchema, '/api/runs/deal-brief', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(startBriefRequestSchema.parse(input))
  });
}

/** Cancels an in-progress brief-generation run. */
export function cancelRun(runId: string, csrfToken: string): Promise<CancelRunResponse> {
  return requestJson(cancelRunResponseSchema, `/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: '{}'
  });
}

/** Loads the approval requests visible to the active persona. */
export function fetchApprovals(signal: AbortSignal | undefined): Promise<ApprovalInboxResponse> {
  return requestJson(approvalInboxResponseSchema, '/api/approvals', { signal });
}

/** Loads the authorized detail for a selected approval request. */
export function fetchApprovalDetail(
  subjectId: string,
  signal: AbortSignal | undefined
): Promise<ApprovalDetailResponse> {
  return requestJson(
    approvalDetailResponseSchema,
    `/api/approvals/${encodeURIComponent(subjectId)}`,
    { signal }
  );
}

/** Records the active persona's decision on an approval request. */
export function decideApproval(
  input: ApprovalDecisionRequest,
  csrfToken: string
): Promise<ApprovalDecisionResult> {
  return requestJson(approvalDecisionResultSchema, '/api/approvals/decisions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(approvalDecisionRequestSchema.parse(input))
  });
}
