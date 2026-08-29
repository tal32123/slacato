import {
  authErrorResponseSchema,
  authSessionResponseSchema,
  authenticatedMutationResponseSchema,
  csrfResponseSchema,
  demoDiagnosticsResponseSchema,
  dealListResponseSchema,
  dealWorkspaceViewSchema,
  logoutResponseSchema,
  personaListResponseSchema,
  approvalDecisionRequestSchema,
  approvalDecisionResultSchema,
  approvalDetailResponseSchema,
  approvalInboxResponseSchema,
  runDetailResponseSchema,
  runListResponseSchema,
  startBriefRequestSchema,
  startBriefResponseSchema,
  type AuthSessionResponse,
  type DealListResponse,
  type DealWorkspaceView,
  type DemoDiagnosticsResponse,
  type Persona,
  type ApprovalDecisionRequest,
  type ApprovalDecisionResult,
  type ApprovalDetailResponse,
  type ApprovalInboxResponse,
  type RunDetailResponse,
  type RunListResponse,
  type StartBriefRequest,
  type StartBriefResponse,
} from '@slacato/contracts';

interface WireSchema<T> {
  parse(input: unknown): T;
}

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code?: 'UNAUTHORIZED' | 'FORBIDDEN' | 'INVALID_CSRF'
  ) {
    super(status === 401 ? 'Authentication is required.' : 'The request could not be completed.');
  }
}

export async function requestJson<T>(schema: WireSchema<T>, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch((): undefined => undefined);
    const parsed = authErrorResponseSchema.safeParse(body);
    throw new ApiError(response.status, parsed.success ? parsed.data.code : undefined);
  }
  return schema.parse(await response.json());
}

export function fetchSession(signal?: AbortSignal): Promise<AuthSessionResponse> {
  return requestJson(authSessionResponseSchema, '/api/auth/session', { signal });
}

export async function fetchPersonas(signal?: AbortSignal): Promise<readonly Persona[]> {
  return (await requestJson(personaListResponseSchema, '/api/auth/personas', { signal })).personas;
}

export async function fetchCsrf(signal?: AbortSignal): Promise<string> {
  return (await requestJson(csrfResponseSchema, '/api/auth/csrf', { signal })).csrfToken;
}

export function changePersona(userId: string, csrfToken: string) {
  return requestJson(authenticatedMutationResponseSchema, '/api/auth/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ userId })
  });
}

export function endSession(csrfToken: string) {
  return requestJson(logoutResponseSchema, '/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: '{}'
  });
}

export function fetchDiagnostics(signal: AbortSignal | undefined): Promise<DemoDiagnosticsResponse> {
  return requestJson(demoDiagnosticsResponseSchema, '/api/diagnostics', { signal });
}

export function fetchDeals(signal: AbortSignal | undefined): Promise<DealListResponse> {
  return requestJson(dealListResponseSchema, '/api/deals', { signal });
}

export function fetchDealWorkspace(opportunityId: string, signal: AbortSignal | undefined): Promise<DealWorkspaceView> {
  return requestJson(dealWorkspaceViewSchema, `/api/deals/${encodeURIComponent(opportunityId)}`, { signal });
}

export function fetchRuns(signal: AbortSignal | undefined): Promise<RunListResponse> {
  return requestJson(runListResponseSchema, '/api/runs', { signal });
}

export function fetchRunDetail(runId: string, signal: AbortSignal | undefined): Promise<RunDetailResponse> {
  return requestJson(runDetailResponseSchema, `/api/runs/${encodeURIComponent(runId)}/detail`, { signal });
}

export function startBrief(input: StartBriefRequest, csrfToken: string): Promise<StartBriefResponse> {
  return requestJson(startBriefResponseSchema, '/api/runs/deal-brief', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(startBriefRequestSchema.parse(input))
  });
}

export function fetchApprovals(signal: AbortSignal | undefined): Promise<ApprovalInboxResponse> {
  return requestJson(approvalInboxResponseSchema, '/api/approvals', { signal });
}

export function fetchApprovalDetail(subjectId: string, signal: AbortSignal | undefined): Promise<ApprovalDetailResponse> {
  return requestJson(approvalDetailResponseSchema, `/api/approvals/${encodeURIComponent(subjectId)}`, { signal });
}

export function decideApproval(input: ApprovalDecisionRequest, csrfToken: string): Promise<ApprovalDecisionResult> {
  return requestJson(approvalDecisionResultSchema, '/api/approvals/decisions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(approvalDecisionRequestSchema.parse(input))
  });
}
