/**
 * Provider-neutral durable accounting for a single outbound generation attempt.
 * Implementations must record the attempt before the provider is contacted.
 */
export type ProviderAttemptContext = Readonly<{
  runScope: string;
  /** Stable workflow generation identity that survives lease takeover. */
  logicalGenerationId?: string | undefined;
  invocationId?: string | undefined;
  provider: string;
  model: string;
}>;

export type ProviderAttemptReservation = Readonly<{
  reservationId: string;
  attemptId: string;
  /** Authoritative ordinal assigned by the durable ledger, never by a process. */
  ordinal: number;
  grantedOutputTokens: number;
}>;

export type ProviderAttemptUsage = Readonly<{
  reservedInputTokens: number;
  actualInputTokens?: number | undefined;
  actualOutputTokens?: number | undefined;
  requestId?: string | undefined;
  responseId?: string | undefined;
}>;

export type ProviderAttemptFailure = Readonly<{
  disposition: 'safe_not_sent' | 'possibly_sent';
  category?: string | undefined;
  diagnosticCode?: string | undefined;
}>;

export class ProviderAttemptFinalizationConflict extends Error {
  public constructor(message = 'Provider attempt was already finalized differently') {
    super(message);
    this.name = 'ProviderAttemptFinalizationConflict';
  }
}

export interface ProviderAttemptLedger {
  beginAttempt(input: ProviderAttemptContext & Readonly<{
    operation: string;
    inputTokens: number;
    requestedOutputTokens: number;
  }>): Promise<ProviderAttemptReservation>;
  settleAttempt(input: ProviderAttemptReservation & ProviderAttemptUsage): Promise<void>;
  releaseAttempt(input: ProviderAttemptReservation & ProviderAttemptFailure): Promise<void>;
  recordAttemptMetadata?(input: Readonly<{
    attemptId: string;
    outputMode: 'native_schema' | 'prompted_json';
    validationAttempts: number;
    validationIssues: readonly Readonly<{ path: string; code: string; message: string }>[];
    warnings: readonly string[];
  }>): Promise<void>;
}
