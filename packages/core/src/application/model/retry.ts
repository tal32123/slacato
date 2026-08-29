import type {
  ModelErrorCategory,
  NormalizedModelError,
  OutputReservation,
  RetryLimits,
  RunBudgetLimits,
  SharedRunBudget
} from './contracts.js';

/** Signals that a model request exhausted a configured call, token, retry, or time limit. */
export class RetryLimitExceededError extends Error {
  /** Creates a retry-limit error with an explanation for the rejected work. */
  public constructor(message: string) {
    super(message);
    this.name = 'RetryLimitExceededError';
  }
}

/** Signals that a provider used more output than was reserved for its request. */
export class OutputBudgetOverrunError extends RetryLimitExceededError {
  /** Creates an output-budget error with the underlying accounting failure when available. */
  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OutputBudgetOverrunError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Carries a provider failure in the stable categories used by application workflows. */
export class ModelGatewayTransportError extends Error {
  /** Creates a transport error from its provider-neutral failure details. */
  public constructor(public readonly normalized: NormalizedModelError) {
    super(normalized.message ?? `Model transport error: ${normalized.category}`);
    this.name = 'ModelGatewayTransportError';
  }
  /** Reports the failure category that governs retry behavior. */
  public get category(): ModelErrorCategory {
    return this.normalized.category;
  }
}

type RetrySnapshot = Readonly<{
  calls: number;
  inputTokens: number;
  schemaRepairs: number;
  transportRetries: number;
  outputTokens: number;
  reservedOutputTokens: number;
}>;
type AttemptReservation = Readonly<{
  id: number;
  grantedOutputTokens: number;
  shared?: OutputReservation | undefined;
}>;
const TRANSIENT_CATEGORIES = new Set<ModelErrorCategory>([
  'transient_transport',
  'rate_limited',
  'server'
]);
const SAFE_DIAGNOSTIC_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE'
]);

/** Treats an object-like failure as an error record. */
function asErrorRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Accepts only valid provider HTTP error statuses. */
function trustedStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}
/** Maps a provider status and retry signal to a stable failure category. */
function categoryForStatus(status: number | undefined, retryable: boolean): ModelErrorCategory {
  if (status === 401 || status === 403) return 'authorization';
  if (status === 429) return 'rate_limited';
  if (status !== undefined && status >= 400 && status < 500) return 'nonretryable_client';
  if (status !== undefined && status >= 500 && retryable) return 'server';
  return 'unknown';
}
/** Exposes only diagnostic codes approved for logs and retry decisions. */
function safeDiagnosticCode(source: Record<string, unknown> | undefined): string | undefined {
  const code = source?.code;
  return typeof code === 'string' && SAFE_DIAGNOSTIC_CODES.has(code) ? code : undefined;
}

/** Converts provider failures into stable categories that control whether requests may retry. */
export function normalizeModelError(error: unknown): ModelGatewayTransportError {
  if (error instanceof ModelGatewayTransportError) return error;
  const source = asErrorRecord(error);
  const status = trustedStatus(source?.statusCode);
  const category = categoryForStatus(status, source?.retryable === true);
  const diagnosticCode = safeDiagnosticCode(source);
  return new ModelGatewayTransportError({
    category,
    ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    ...(status === undefined ? {} : { statusCode: status }),
    message: 'Model transport request failed',
    delivery: 'possibly_sent'
  });
}

/** Tracks and reserves the total model-call budget shared by concurrent specialists. */
export class RunBudgetLedger implements SharedRunBudget {
  public readonly scope: string;
  private readonly deadlineAt: number;
  private calls = 0;
  private nextReservationId = 0;
  private readonly reservations = new Map<number, number>();

  /** Creates a shared run budget with its capacity and deadline. */
  public constructor(private readonly limits: RunBudgetLimits) {
    this.scope = limits.scope;
    this.deadlineAt = Date.now() + limits.deadlineMs;
  }

  /** Reserves one model call and its expected token capacity for a specialist. */
  public reserveAttempt(_inputTokens: number, requestedOutputTokens: number): OutputReservation {
    this.assertDeadline();
    if (this.calls >= this.limits.maxCalls)
      throw new RetryLimitExceededError('Shared run call limit reached');
    const grantedOutputTokens = Math.max(1, requestedOutputTokens);
    const id = this.nextReservationId++;
    this.calls += 1;
    this.reservations.set(id, grantedOutputTokens);
    return { id, grantedOutputTokens };
  }

  /** Accepts input usage without retaining unused aggregate token counters. */
  public reconcileInputTokens(
    _reservedTokens: number,
    _consumedTokens: number | undefined
  ): void {
    // Shared budgeting enforces reservations, calls, and deadlines rather than token totals.
  }

  /** Finalizes a reservation without retaining aggregate output usage. */
  public settleAttempt(
    reservation: OutputReservation,
    _actualOutputTokens: number | undefined
  ): void {
    this.takeReservation(reservation);
  }

  /** Releases the output capacity held by a call that did not complete. */
  public releaseAttempt(reservation: OutputReservation): void {
    this.takeReservation(reservation);
  }
  /** Rejects new or continuing work once the shared run deadline has passed. */
  public assertDeadline(): void {
    if (Date.now() >= this.deadlineAt)
      throw new RetryLimitExceededError('Shared run deadline reached');
  }

  /** Closes a known shared reservation exactly once and returns its reserved capacity. */
  private takeReservation(reservation: OutputReservation): number {
    const granted = this.reservations.get(reservation.id);
    if (granted === undefined || granted !== reservation.grantedOutputTokens)
      throw new RetryLimitExceededError('Unknown or settled shared output reservation');
    this.reservations.delete(reservation.id);
    return granted;
  }
}

/** Enforces per-generation limits for model calls, retries, time, and token usage. */
export class BoundedRetryController {
  private readonly startedAt = Date.now();
  private calls = 0;
  private inputTokens = 0;
  private schemaRepairs = 0;
  private transportRetries = 0;
  private outputTokens = 0;
  private reservedOutputTokens = 0;
  private nextReservationId = 0;
  private readonly reservations = new Map<number, AttemptReservation>();

  /** Creates a generation budget with optional participation in the shared run budget. */
  public constructor(
    private readonly limits: RetryLimits,
    private readonly shared?: SharedRunBudget
  ) {}

  /** Starts one bounded model call and reserves its local and shared output capacity. */
  public beginCall(inputTokens: number, requestedOutputTokens: number): AttemptReservation {
    this.assertDeadline();
    if (this.calls >= this.limits.maxCalls)
      throw new RetryLimitExceededError('Total model call limit reached');
    const requested = Math.max(1, requestedOutputTokens);
    const sharedReservation = this.shared?.reserveAttempt(inputTokens, requested);
    const grantedOutputTokens = sharedReservation?.grantedOutputTokens ?? requested;
    const reservation: AttemptReservation = {
      id: this.nextReservationId++,
      grantedOutputTokens,
      ...(sharedReservation === undefined ? {} : { shared: sharedReservation })
    };
    this.calls += 1;
    this.inputTokens += inputTokens;
    this.reservedOutputTokens += grantedOutputTokens;
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  /** Finalizes a local attempt and reconciles its usage with the shared run budget. */
  public settleAttempt(
    reservation: AttemptReservation,
    actualOutputTokens: number | undefined
  ): void {
    const granted = this.closeReservation(reservation);
    const actual = actualOutputTokens ?? granted;
    this.outputTokens += actual;
    let sharedFailure: unknown;
    if (reservation.shared !== undefined) {
      try {
        this.shared?.settleAttempt(reservation.shared, actualOutputTokens);
      } catch (error) {
        sharedFailure = error;
      }
    }
    if (sharedFailure !== undefined)
      throw new OutputBudgetOverrunError(
        'Shared provider-attempt accounting failed',
        sharedFailure
      );
  }

  /** Releases the capacity held by an unsuccessful local and shared attempt. */
  public releaseAttempt(reservation: AttemptReservation): void {
    this.closeReservation(reservation);
    if (reservation.shared !== undefined) this.shared?.releaseAttempt(reservation.shared);
  }

  /** Records one schema-repair attempt without exceeding its configured limit. */
  public recordSchemaRepair(): void {
    if (this.schemaRepairs >= this.limits.maxSchemaRepairs)
      throw new RetryLimitExceededError('Schema repair limit reached');
    this.schemaRepairs += 1;
  }
  /** Reconciles reported input usage with both local and shared accounting. */
  public recordInputTokens(reservedTokens: number, consumedTokens: number | undefined): void {
    const additional = Math.max(0, (consumedTokens ?? 0) - reservedTokens);
    this.inputTokens += additional;
    this.shared?.reconcileInputTokens(reservedTokens, consumedTokens);
  }
  /** Reports whether a provider failure remains eligible for another transport attempt. */
  public canRetryTransport(error: unknown): boolean {
    const normalized = normalizeModelError(error);
    const status = normalized.normalized.statusCode;
    const nonRetryableStatus =
      status === 401 ||
      status === 403 ||
      (status !== undefined && status >= 400 && status < 500 && status !== 429);
    return (
      !nonRetryableStatus &&
      TRANSIENT_CATEGORIES.has(normalized.category) &&
      this.transportRetries < this.limits.maxTransportRetries &&
      this.calls < this.limits.maxCalls &&
      !this.deadlineExceeded()
    );
  }
  /** Records an eligible transport retry and returns its jittered backoff delay. */
  public recordTransportRetry(error: unknown): number {
    if (!this.canRetryTransport(error))
      throw new RetryLimitExceededError('Transport retry limit reached or error is not retryable');
    this.transportRetries += 1;
    const exponential = Math.min(1_000, 50 * 2 ** (this.transportRetries - 1));
    return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
  }
  /** Rejects generation work after either the local or shared deadline. */
  public assertDeadline(): void {
    if (this.deadlineExceeded()) throw new RetryLimitExceededError('Generation deadline reached');
    this.shared?.assertDeadline();
  }
  /** Returns the absolute time at which generation must stop. */
  public deadlineAt(): number {
    return this.startedAt + this.limits.deadlineMs;
  }
  /** Reports the generation budget consumed and currently reserved. */
  public snapshot(): RetrySnapshot {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      schemaRepairs: this.schemaRepairs,
      transportRetries: this.transportRetries,
      outputTokens: this.outputTokens,
      reservedOutputTokens: this.reservedOutputTokens
    };
  }
  /** Closes a known local reservation exactly once and returns its reserved capacity. */
  private closeReservation(reservation: AttemptReservation): number {
    const active = this.reservations.get(reservation.id);
    if (active !== reservation)
      throw new RetryLimitExceededError('Unknown or settled local output reservation');
    this.reservations.delete(reservation.id);
    this.reservedOutputTokens -= reservation.grantedOutputTokens;
    return reservation.grantedOutputTokens;
  }
  /** Reports whether the generation deadline has passed. */
  private deadlineExceeded(): boolean {
    return Date.now() >= this.deadlineAt();
  }
}
