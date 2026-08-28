import type { RetryLimits } from './contracts.js';

export class RetryLimitExceededError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RetryLimitExceededError';
  }
}

type RetrySnapshot = Readonly<{ calls: number; schemaRepairs: number; transportRetries: number; outputTokens: number }>;

/** One controller accounts for every model call and all retry dimensions. */
export class BoundedRetryController {
  private readonly startedAt = Date.now();
  private calls = 0;
  private schemaRepairs = 0;
  private transportRetries = 0;
  private outputTokens = 0;

  public constructor(private readonly limits: RetryLimits) {}

  public beginCall(): void {
    this.assertBeforeCall();
    this.calls += 1;
  }

  public recordSchemaRepair(): void {
    if (this.schemaRepairs >= this.limits.maxSchemaRepairs) throw new RetryLimitExceededError('Schema repair limit reached');
    this.schemaRepairs += 1;
  }

  public canRetryTransport(error: unknown): boolean {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode : undefined;
    const retryable = typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true;
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    const transientNetworkCode = code !== undefined && ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(code);
    if (statusCode !== undefined && statusCode !== 408 && statusCode !== 429 && statusCode < 500) return false;
    if (statusCode === undefined && !retryable && !transientNetworkCode) return false;
    if (typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false) return false;
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
  }

  public deadlineAt(): number { return this.startedAt + this.limits.deadlineMs; }
  public snapshot(): RetrySnapshot { return { calls: this.calls, schemaRepairs: this.schemaRepairs, transportRetries: this.transportRetries, outputTokens: this.outputTokens }; }

  private assertBeforeCall(): void {
    if (this.deadlineExceeded()) throw new RetryLimitExceededError('Generation deadline reached');
    if (this.calls >= this.limits.maxCalls) throw new RetryLimitExceededError('Total model call limit reached');
  }

  private deadlineExceeded(): boolean { return Date.now() >= this.deadlineAt(); }
}
