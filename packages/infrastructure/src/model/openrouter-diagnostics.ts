/** Extracts only a short identifier-safe provider reason; prompts and response bodies never cross the log boundary. */
export function openRouterDiagnosticCode(
  statusCode: number | undefined,
  responseBody: string | undefined
): string {
  let reason = 'api_error';
  try {
    const parsed = JSON.parse(responseBody ?? '') as {
      error?: { message?: unknown; metadata?: { raw?: unknown } };
    };
    const raw = parsed.error?.metadata?.raw;
    let nestedMessage: unknown;
    if (typeof raw === 'string') {
      try {
        nestedMessage = (JSON.parse(raw) as { error?: { message?: unknown } }).error?.message;
      } catch {
        /* unstructured provider metadata is never logged */
      }
    }
    const message = nestedMessage ?? parsed.error?.message;
    if (typeof message === 'string') {
      const slug = message
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 96);
      if (slug.length > 0) reason = slug;
    }
  } catch {
    /* malformed provider bodies remain opaque */
  }
  return `openrouter_${statusCode ?? 'unknown'}_${reason}`.slice(0, 128);
}
