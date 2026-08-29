const REDACTED = '[REDACTED]' as const;
const CIRCULAR = '[Circular]' as const;
const TRUNCATED = '[Truncated]' as const;
const UNSUPPORTED = '[Unsupported]' as const;
const MAX_DEPTH = 64;

export type SafeLogPrimitive = string | number | boolean | null;
export type SafeLogPayload = SafeLogPrimitive | readonly SafeLogPayload[] | { readonly [key: string]: SafeLogPayload };

const exactSensitiveKeys: Readonly<Record<string, true>> = {
  authorization: true, proxyauthorization: true, cookie: true, setcookie: true,
  auth: true, authentication: true, credential: true, credentials: true, msg: true, err: true, error: true,
  stack: true, cause: true,
  apikey: true, xapikey: true, password: true, passwd: true, secret: true, clientsecret: true,
  token: true, accesstoken: true, refreshtoken: true, sessiontoken: true, csrftoken: true,
  body: true, requestbody: true, responsebody: true,
  content: true, prompttext: true, completiontext: true,
  sourcebody: true, sourcebodies: true, sourcecontent: true, sourcecontents: true, documentcontent: true,
  evidenceexcerpt: true, evidenceexcerpts: true, excerpt: true, excerpts: true
};

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return exactSensitiveKeys[normalized] === true
    || normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.endsWith('auth')
    || normalized.endsWith('authentication')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials')
    || normalized.endsWith('token')
    || normalized.endsWith('apikey')
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('message')
    || normalized.endsWith('messages')
    || normalized.endsWith('prompt')
    || normalized.endsWith('prompts')
    || normalized.endsWith('completion')
    || normalized.endsWith('completions')
    || normalized.endsWith('prompttext')
    || normalized.endsWith('completiontext')
    || normalized.endsWith('sourcebody')
    || normalized.endsWith('sourcecontent')
    || normalized.endsWith('sourcebodies')
    || normalized.endsWith('sourcecontents')
    || normalized.endsWith('evidenceexcerpts')
    || normalized.endsWith('evidenceexcerpt');
}

function safeErrorName(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : 'Error';
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) ? value : undefined;
}

function redact(value: unknown, ancestors: WeakSet<object>, depth: number): SafeLogPayload {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return null;
  if (typeof value === 'symbol' || typeof value === 'function') return UNSUPPORTED;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (ancestors.has(value)) return CIRCULAR;

  ancestors.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? REDACTED : value.toISOString();
    if (value instanceof Error) {
      const safe: Record<string, SafeLogPayload> = {
        name: safeErrorName(value.name),
        message: REDACTED,
        stack: REDACTED,
        cause: REDACTED
      };
      const code = safeErrorCode((value as Error & { code?: unknown }).code);
      if (code !== undefined) safe.code = code;
      return safe;
    }
    if (Array.isArray(value)) return value.map((entry) => redact(entry, ancestors, depth + 1));

    const safe: Record<string, SafeLogPayload> = {};
    for (const key of Object.keys(value)) {
      let entry: unknown;
      try {
        entry = (value as Record<string, unknown>)[key];
      } catch {
        entry = REDACTED;
      }
      Object.defineProperty(safe, key, {
        value: isSensitiveKey(key) ? REDACTED : redact(entry, ancestors, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return safe;
  } finally {
    ancestors.delete(value);
  }
}

/** Converts arbitrary values into bounded JSON-safe data before a logging sink can observe them. */
export function redactLogPayload(value: unknown): SafeLogPayload {
  return redact(value, new WeakSet(), 0);
}
