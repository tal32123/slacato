const REDACTED = '[REDACTED]' as const;

export type SafeLogPrimitive = string | number | boolean | null;
export type SafeLogPayload = SafeLogPrimitive | readonly SafeLogPayload[] | { readonly [key: string]: SafeLogPayload };

type SafeField =
  | 'event'
  | 'correlationId'
  | 'runId'
  | 'attemptId'
  | 'status'
  | 'provider'
  | 'model'
  | 'durationMs'
  | 'retryCount'
  | 'inputTokens'
  | 'outputTokens'
  | 'errorCode';

const safeFields: Readonly<Record<SafeField, true>> = {
  event: true,
  correlationId: true,
  runId: true,
  attemptId: true,
  status: true,
  provider: true,
  model: true,
  durationMs: true,
  retryCount: true,
  inputTokens: true,
  outputTokens: true,
  errorCode: true
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const eventPattern = /^[a-z][a-z0-9_]{0,127}$/;
const statusPattern = /^[a-z][a-z0-9_]{0,63}$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;

function safeString(field: SafeField, value: unknown): string | typeof REDACTED {
  if (typeof value !== 'string') return REDACTED;
  const pattern = field === 'event' ? eventPattern
    : field === 'status' ? statusPattern
      : field === 'errorCode' ? errorCodePattern
        : identifierPattern;
  return pattern.test(value) ? value : REDACTED;
}

function safeNumber(value: unknown): number | typeof REDACTED {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : REDACTED;
}

function sanitizeField(field: SafeField, value: unknown): SafeLogPayload {
  if (field === 'durationMs' || field === 'retryCount' || field === 'inputTokens' || field === 'outputTokens') {
    return safeNumber(value);
  }
  return safeString(field, value);
}

function isSafeField(key: string): key is SafeField {
  return Object.prototype.hasOwnProperty.call(safeFields, key);
}

/**
 * Projects an arbitrary value onto the documented telemetry allowlist.
 * Unknown keys and every container value are redacted without traversal.
 */
export function redactLogPayload(value: unknown): SafeLogPayload {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return REDACTED;
    const keys = Object.keys(value);
    const output: Record<string, SafeLogPayload> = {};
    for (const key of keys) {
      let fieldValue: unknown;
      try {
        fieldValue = (value as Record<string, unknown>)[key];
      } catch {
        fieldValue = REDACTED;
      }
      const safeValue = isSafeField(key) ? sanitizeField(key, fieldValue) : REDACTED;
      Object.defineProperty(output, key, { configurable: true, enumerable: true, value: safeValue, writable: true });
    }
    return output;
  } catch {
    return REDACTED;
  }
}
