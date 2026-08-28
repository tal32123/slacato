import type { RetryLimits, RunBudgetLimits, SharedRunBudget } from './contracts.js';

export class RetryLimitExceededError extends Error {
  public constructor(message: string) { super(message); this.name = 'RetryLimitExceededError'; }
}

type RetrySnapshot = Readonly<{ calls: number; inputTokens: number; schemaRepairs: number; transportRetries: number; outputTokens: number }>;
const NON_RETRYABLE_CODES = new Set(['AUTHORIZATION_DENIED', 'POLICY_DENIED', 'CONTENT_FILTERED', 'DETERMINISTIC_CITATION_FAILURE']);

/** Shared synchronous reservations make cross-specialist limits safe under JavaScript concurrency. */
export class RunBudgetLedger implements SharedRunBudget {
  public readonly scope: string;
  private readonly deadlineAt: number;
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  public constructor(private readonly limits: RunBudgetLimits) {
    this.scope = limits.scope;
    this.deadlineAt = Date.now() + limits.deadlineMs;
  }

  public reserveCall(inputTokens: number): void {
    this.assertDeadline();
    if (this.calls >= this.limits.maxCalls) throw new RetryLimitExceededError('Shared run call limit reached');
    if (this.inputTokens + inputTokens > this.limits.maxInputTokens) throw new RetryLimitExceededError('Shared run input token budget reached');
    this.calls += 1;
    this.inputTokens += inputTokens;
  }

  public reconcileInputTokens(reservedTokens: number, consumedTokens: number | undefined): void {
    const additional = Math.max(0, (consumedTokens ?? 0) - reservedTokens);
    if (this.inputTokens + additional > this.limits.maxInputTokens) throw new RetryLimitExceededError('Shared run input token budget reached');
    this.inputTokens += additional;
  }

  public recordOutputTokens(outputTokens: number | undefined): void {
    this.outputTokens += outputTokens ?? 0;
    if (this.outputTokens > this.limits.maxOutputTokens) throw new RetryLimitExceededError('Shared run output token budget reached');
  }

  public assertDeadline(): void {
    if (Date.now() >= this.deadlineAt) throw new RetryLimitExceededError('Shared run deadline reached');
  }
}

/** One controller accounts for every model call and all retry dimensions. */
export class BoundedRetryController {
  private readonly startedAt = Date.now();
  private calls = 0;
  private inputTokens = 0;
  private schemaRepairs = 0;
  private transportRetries = 0;
  private outputTokens = 0;

  public constructor(private readonly limits: RetryLimits, private readonly shared?: SharedRunBudget) {}

  public beginCall(inputTokens: number): void {
    this.assertDeadline();
    if (this.calls >= this.limits.maxCalls) throw new RetryLimitExceededError('Total model call limit reached');
    if (this.inputTokens + inputTokens > this.limits.maxInputTokens) throw new RetryLimitExceededError('Input token budget reached');
    this.shared?.reserveCall(inputTokens);
    this.calls += 1;
    this.inputTokens += inputTokens;
  }

  public recordSchemaRepair(): void {
    if (this.schemaRepairs >= this.limits.maxSchemaRepairs) throw new RetryLimitExceededError('Schema repair limit reached');
    this.schemaRepairs += 1;
  }

  public recordInputTokens(reservedTokens: number, consumedTokens: number | undefined): void {
    const additional = Math.max(0, (consumedTokens ?? 0) - reservedTokens);
    if (this.inputTokens + additional > this.limits.maxInputTokens) throw new RetryLimitExceededError('Input token budget reached');
    this.inputTokens += additional;
    this.shared?.reconcileInputTokens(reservedTokens, consumedTokens);
  }

  public canRetryTransport(error: unknown): boolean {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    const retryable = typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true;
    const transientNetworkCode = code !== undefined && ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(code);
    if (code !== undefined && NON_RETRYABLE_CODES.has(code)) return false;
    if (statusCode !== undefined && statusCode !== 408 && statusCode !== 429 && statusCode < 500) return false;
    if (typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false) return false;
    if (statusCode === undefined && !retryable && !transientNetworkCode) return false;
    return this.transportRetries < this.limits.maxTransportRetries && this.calls < this.limits.maxCalls && !this.deadlineExceeded();
  }

  public recordTransportRetry(error: unknown): number {
    if (!this.canRetryTransport(error)) throw new RetryLimitExceededError('Transport retry limit reached or error is not retryable');
    this.transportRetries += 1;
    const exponential = Math.min(1_000, 50 * 2 ** (this.transportRetries - 1));
    return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
  }

  public recordOutputTokens(tokens: number | undefined): void {
    this.outputTokens += tokens ?? 0;
    if (this.outputTokens > this.limits.maxOutputTokens) throw new RetryLimitExceededError('Output token budget reached');
    this.shared?.recordOutputTokens(tokens);
  }

  public assertDeadline(): void { if (this.deadlineExceeded()) throw new RetryLimitExceededError('Generation deadline reached'); this.shared?.assertDeadline(); }
  public deadlineAt(): number { return this.startedAt + this.limits.deadlineMs; }
  public snapshot(): RetrySnapshot { return { calls: this.calls, inputTokens: this.inputTokens, schemaRepairs: this.schemaRepairs, transportRetries: this.transportRetries, outputTokens: this.outputTokens }; }
  private deadlineExceeded(): boolean { return Date.now() >= this.deadlineAt(); }
}
