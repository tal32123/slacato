const OPENROUTER_DIAGNOSTIC_CODES = {
  apiError: 'openrouter_api_error',
  authorization: 'openrouter_authorization',
  clientError: 'openrouter_client_error',
  rateLimited: 'openrouter_rate_limited',
  serverError: 'openrouter_server_error'
} as const;

/** Maps trusted HTTP status classes to locally owned codes; provider response text stays opaque. */
export function openRouterDiagnosticCode(
  statusCode: number | undefined,
  _responseBody: string | undefined
): string {
  if (statusCode === 401 || statusCode === 403) {
    return OPENROUTER_DIAGNOSTIC_CODES.authorization;
  }
  if (statusCode === 429) return OPENROUTER_DIAGNOSTIC_CODES.rateLimited;
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return OPENROUTER_DIAGNOSTIC_CODES.clientError;
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode < 600) {
    return OPENROUTER_DIAGNOSTIC_CODES.serverError;
  }
  return OPENROUTER_DIAGNOSTIC_CODES.apiError;
}
