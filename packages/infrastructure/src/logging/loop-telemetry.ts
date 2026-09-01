import type { Logger } from 'pino';

export type LoopFailureReport = Readonly<{
  event: string;
  errorCode: string;
  error: unknown;
  durationMs: number;
  consecutiveFailures: number;
}>;

/** Names the failing error class without leaking its message through the telemetry allowlist. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'UnknownError';
}

/**
 * Emits the one record that makes a stalled background loop visible.
 *
 * Delivery loops swallow their failures to stay alive across transient outages, so a permanently
 * failing loop is indistinguishable from an idle one unless every discarded pass is reported.
 */
export function reportLoopFailure(telemetry: Logger, report: LoopFailureReport): void {
  telemetry.error({
    event: report.event,
    status: 'failed',
    durationMs: Math.max(0, report.durationMs),
    retryCount: Math.max(0, report.consecutiveFailures - 1),
    errorName: errorName(report.error),
    errorCode: report.errorCode
  });
}
