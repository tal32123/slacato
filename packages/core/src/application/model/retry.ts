import type { ModelErrorCategory, NormalizedModelError, OutputReservation, RetryLimits, RunBudgetLimits, SharedRunBudget } from './contracts.js';

export class RetryLimitExceededError extends Error {
  public constructor(message: string) { super(message); this.name = 'RetryLimitExceededError'; }
}

/** The provider used more output than the capacity reserved before transport. */
export class OutputBudgetOverrunError extends RetryLimitExceededError {
  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OutputBudgetOverrunError';
    if (cause !== undefined) this.cause = cause;
  }
}

export class ModelGatewayTransportError extends Error {
  public constructor(public readonly normalized: NormalizedModelError, cause?: unknown) {
    super(normalized.message ?? `Model transport error: ${normalized.category}`);
    this.name = 'ModelGatewayTransportError';
    if (cause !== undefined) this.cause = cause;
  }
  public get category(): ModelErrorCategory { return this.normalized.category; }
}

type RetrySnapshot = Readonly<{ calls: number; inputTokens: number; schemaRepairs: number; transportRetries: number; outputTokens: number; reservedOutputTokens: number }>;
type AttemptReservation = Readonly<{ id: number; grantedOutputTokens: number; shared?: OutputReservation | undefined }>;
const CATEGORIES: readonly ModelErrorCategory[] = ['transient_transport', 'rate_limited', 'server', 'authorization', 'policy', 'content_filter', 'deterministic_validation', 'deterministic_citation', 'nonretryable_client', 'unknown'];
const TRANSIENT_CATEGORIES = new Set<ModelErrorCategory>(['transient_transport', 'rate_limited', 'server']);

function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined; }

/** Provider-neutral normalization: categories govern retries; codes remain diagnostics only. */
export function normalizeModelError(error: unknown): ModelGatewayTransportError {
  if (error instanceof ModelGatewayTransportError) return error;
  const source = record(error);
  const declared = source?.['category'];
  const status = typeof source?.['statusCode'] === 'number' ? source.statusCode : undefined;
  const category: ModelErrorCategory = typeof declared === 'string' && CATEGORIES.includes(declared as ModelErrorCategory)
    ? declared as ModelErrorCategory
    : status === 401 || status === 403 ? 'authorization'
      : status === 429 ? 'rate_limited'
        : status !== undefined && status >= 500 ? 'server'
          : status !== undefined && status >= 400 ? 'nonretryable_client'
            : 'unknown';
  return new ModelGatewayTransportError({
    category,
    ...(typeof source?.['code'] === 'string' ? { diagnosticCode: source.code } : {}),
    ...(status === undefined ? {} : { statusCode: status }),
    ...(error instanceof Error ? { message: error.message } : {})
  }, error);
}

/** Shared synchronous reservations make cross-specialist output capacity safe under concurrency. */
export class RunBudgetLedger implements SharedRunBudget {
  public readonly scope: string;
  private readonly deadlineAt: number;
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private reservedOutputTokens = 0;
  private nextReservationId = 0;
  private readonly reservations = new Map<number, number>();

  public constructor(private readonly limits: RunBudgetLimits) { this.scope = limits.scope; this.deadlineAt = Date.now() + limits.deadlineMs; }

  public reserveAttempt(inputTokens: number, requestedOutputTokens: number): OutputReservation {
    this.assertDeadline();
    if (this.calls >= this.limits.maxCalls) throw new RetryLimitExceededError('Shared run call limit reached');
    if (this.inputTokens + inputTokens > this.limits.maxInputTokens) throw new RetryLimitExceededError('Shared run input token budget reached');
    const available = this.limits.maxOutputTokens - this.outputTokens - this.reservedOutputTokens;
    const grantedOutputTokens = Math.min(requestedOutputTokens, available);
    if (grantedOutputTokens <= 0) throw new RetryLimitExceededError('Shared run output token budget reached');
    const id = this.nextReservationId++;
    this.calls += 1;
    this.inputTokens += inputTokens;
    this.reservedOutputTokens += grantedOutputTokens;
    this.reservations.set(id, grantedOutputTokens);
    return { id, grantedOutputTokens };
  }

  public reconcileInputTokens(reservedTokens: number, consumedTokens: number | undefined): void {
    const additional = Math.max(0, (consumedTokens ?? 0) - reservedTokens);
    if (this.inputTokens + additional > this.limits.maxInputTokens) throw new RetryLimitExceededError('Shared run input token budget reached');
    this.inputTokens += additional;
  }

  public settleAttempt(reservation: OutputReservation, actualOutputTokens: number | undefined): void {
    const granted = this.takeReservation(reservation);
    const actual = actualOutputTokens ?? granted;
    this.reservedOutputTokens -= granted;
    this.outputTokens += actual;
    if (actual > granted || this.outputTokens + this.reservedOutputTokens > this.limits.maxOutputTokens) {
      throw new OutputBudgetOverrunError('Provider output overrun exceeds the shared granted token budget');
    }
  }

  public releaseAttempt(reservation: OutputReservation): void { this.reservedOutputTokens -= this.takeReservation(reservation); }
  public assertDeadline(): void { if (Date.now() >= this.deadlineAt) throw new RetryLimitExceededError('Shared run deadline reached'); }

  private takeReservation(reservation: OutputReservation): number {
    const granted = this.reservations.get(reservation.id);
    if (granted === undefined || granted !== reservation.grantedOutputTokens) throw new RetryLimitExceededError('Unknown or settled shared output reservation');
    this.reservations.delete(reservation.id);
    return granted;
  }
}

/** One controller accounts for every call and atomically reserves local/shared output capacity. */
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

  public constructor(private readonly limits: RetryLimits, private readonly shared?: SharedRunBudget) {}

  public beginCall(inputTokens: number, requestedOutputTokens: number): AttemptReservation {
    this.assertDeadline();
    if (this.calls >= this.limits.maxCalls) throw new RetryLimitExceededError('Total model call limit reached');
    if (this.inputTokens + inputTokens > this.limits.maxInputTokens) throw new RetryLimitExceededError('Input token budget reached');
    const localAvailable = this.limits.maxOutputTokens - this.outputTokens - this.reservedOutputTokens;
    const requested = Math.min(requestedOutputTokens, localAvailable);
    if (requested <= 0) throw new RetryLimitExceededError('Output token budget reached');
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

  public settleAttempt(reservation: AttemptReservation, actualOutputTokens: number | undefined): void {
    const granted = this.closeReservation(reservation);
    const actual = actualOutputTokens ?? granted;
    this.outputTokens += actual;
    let sharedFailure: unknown;
    if (reservation.shared !== undefined) {
      try { this.shared?.settleAttempt(reservation.shared, actualOutputTokens); }
      catch (error) { sharedFailure = error; }
    }
    if (actual > granted || this.outputTokens + this.reservedOutputTokens > this.limits.maxOutputTokens || sharedFailure !== undefined) {
      throw new OutputBudgetOverrunError('Provider output overrun exceeds the granted token budget', sharedFailure);
    }
  }

  public releaseAttempt(reservation: AttemptReservation): void {
    this.closeReservation(reservation);
    if (reservation.shared !== undefined) this.shared?.releaseAttempt(reservation.shared);
  }

  public recordSchemaRepair(): void { if (this.schemaRepairs >= this.limits.maxSchemaRepairs) throw new RetryLimitExceededError('Schema repair limit reached'); this.schemaRepairs += 1; }
  public recordInputTokens(reservedTokens: number, consumedTokens: number | undefined): void {
    const additional = Math.max(0, (consumedTokens ?? 0) - reservedTokens);
    if (this.inputTokens + additional > this.limits.maxInputTokens) throw new RetryLimitExceededError('Input token budget reached');
    this.inputTokens += additional;
    this.shared?.reconcileInputTokens(reservedTokens, consumedTokens);
  }
  public canRetryTransport(error: unknown): boolean {
    const normalized = normalizeModelError(error);
    return TRANSIENT_CATEGORIES.has(normalized.category) && this.transportRetries < this.limits.maxTransportRetries && this.calls < this.limits.maxCalls && !this.deadlineExceeded();
  }
  public recordTransportRetry(error: unknown): number {
    if (!this.canRetryTransport(error)) throw new RetryLimitExceededError('Transport retry limit reached or error is not retryable');
    this.transportRetries += 1;
    const exponential = Math.min(1_000, 50 * 2 ** (this.transportRetries - 1));
    return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
  }
  public assertDeadline(): void { if (this.deadlineExceeded()) throw new RetryLimitExceededError('Generation deadline reached'); this.shared?.assertDeadline(); }
  public deadlineAt(): number { return this.startedAt + this.limits.deadlineMs; }
  public snapshot(): RetrySnapshot { return { calls: this.calls, inputTokens: this.inputTokens, schemaRepairs: this.schemaRepairs, transportRetries: this.transportRetries, outputTokens: this.outputTokens, reservedOutputTokens: this.reservedOutputTokens }; }
  private closeReservation(reservation: AttemptReservation): number {
    const active = this.reservations.get(reservation.id);
    if (active !== reservation) throw new RetryLimitExceededError('Unknown or settled local output reservation');
    this.reservations.delete(reservation.id);
    this.reservedOutputTokens -= reservation.grantedOutputTokens;
    return reservation.grantedOutputTokens;
  }
  private deadlineExceeded(): boolean { return Date.now() >= this.deadlineAt(); }
}
