import type { RunId } from '../../domain/shared/ids.js';

export type PersistedBudget = Readonly<{ runId: RunId; maxCalls: number; maxInputTokens: number; maxOutputTokens: number; usedCalls: number; usedInputTokens: number; usedOutputTokens: number }>;
/** Restart-safe companion to Task 7's in-process ledger. Reservations prevent concurrent specialists overspending a run. */
export interface RunBudgetStore {
  reserve(input: Readonly<{ id: string; runId: RunId; inputTokens: number; requestedOutputTokens: number }>): Promise<Readonly<{ id: string; grantedOutputTokens: number }>>;
  settle(input: Readonly<{ id: string; actualOutputTokens?: number | undefined; possibleDuplicate: boolean }>): Promise<void>;
  release(id: string): Promise<void>;
  get(runId: RunId): Promise<PersistedBudget | undefined>;
}
