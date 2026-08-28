import type { RunId } from '../../domain/shared/ids.js';

/** Durable provider-call accounting. A provider response may be repeated after crash ambiguity. */
export interface GenerationAttemptStore {
  recordAttemptStarted(input: Readonly<{ id: string; runId: RunId; invocationId?: string | undefined; operation: string; provider: string; model: string }>): Promise<void>;
  completeAttempt(input: Readonly<{ id: string; requestId?: string | undefined; responseId?: string | undefined; inputTokens?: number | undefined; outputTokens?: number | undefined; possibleDuplicate: boolean; status: 'completed' | 'failed' | 'possible_duplicate' }>): Promise<void>;
}
