const REDACTED = '[REDACTED]' as const;

export type SafeLogPrimitive = string | number | boolean | null;
export type SafeLogPayload = SafeLogPrimitive | readonly SafeLogPayload[] | { readonly [key: string]: SafeLogPayload };

const SAFE_FIELD_ORDER = [
  'event',
  'correlationId',
  'runId',
  'attemptId',
  'status',
  'provider',
  'model',
  'durationMs',
  'retryCount',
  'inputTokens',
  'outputTokens',
  'errorCode'
] as const;
type SafeField = typeof SAFE_FIELD_ORDER[number];

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const eventPattern = /^[a-z][a-z0-9_]{0,127}$/;
const statusPattern = /^[a-z][a-z0-9_]{0,63}$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;

/** Keeps only identifier-safe text for an approved telemetry field. */
function safeString(field: SafeField, value: unknown): string | typeof REDACTED {
  if (typeof value !== 'string') return REDACTED;
  const pattern = field === 'event' ? eventPattern
    : field === 'status' ? statusPattern
      : field === 'errorCode' ? errorCodePattern
        : identifierPattern;
  return pattern.test(value) ? value : REDACTED;
}

/** Keeps only nonnegative integer measurements for telemetry. */
function safeNumber(value: unknown): number | typeof REDACTED {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : REDACTED;
}

/** Applies the approved sanitizer for one telemetry field. */
function sanitizeField(field: SafeField, value: unknown): SafeLogPayload {
  if (field === 'durationMs' || field === 'retryCount' || field === 'inputTokens' || field === 'outputTokens') {
    return safeNumber(value);
  }
  return safeString(field, value);
}

/** Distinguishes plain stored values from accessors that must never be invoked during logging. */
const isDataDescriptor = (descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & { value: unknown } =>
  Object.prototype.hasOwnProperty.call(descriptor, 'value');

/** Projects arbitrary input onto the telemetry allowlist without traversing untrusted containers. */
export function redactLogPayload(value: unknown): SafeLogPayload {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return REDACTED;
    const output: Record<string, SafeLogPayload> = {};
    for (const field of SAFE_FIELD_ORDER) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (descriptor === undefined) continue;
      const fieldValue = isDataDescriptor(descriptor) ? descriptor.value : REDACTED;
      output[field] = sanitizeField(field, fieldValue);
    }
    return output;
  } catch {
    return REDACTED;
  }
}
