import { DomainConflictError, type PersistedBudget, type RunBudgetStore } from '@slacato/core';
import type { DatabaseClient } from '../client.js';

type BudgetRow = Readonly<{ run_id: string; max_calls: number; max_input_tokens: number; max_output_tokens: number; used_calls: number; used_input_tokens: number; used_output_tokens: number }>;
function map(row: BudgetRow): PersistedBudget { return { runId: row.run_id as PersistedBudget['runId'], maxCalls: row.max_calls, maxInputTokens: row.max_input_tokens, maxOutputTokens: row.max_output_tokens, usedCalls: row.used_calls, usedInputTokens: row.used_input_tokens, usedOutputTokens: row.used_output_tokens }; }
export class PostgresRunBudgetStore implements RunBudgetStore {
  public constructor(private readonly database: DatabaseClient) {}
  public async get(runId: PersistedBudget['runId']): Promise<PersistedBudget | undefined> { const row = (await this.database.sql<BudgetRow[]>`select run_id, max_calls, max_input_tokens, max_output_tokens, used_calls, used_input_tokens, used_output_tokens from run_budgets where run_id = ${runId}`)[0]; return row === undefined ? undefined : map(row); }
  public async reserve(input: Readonly<{ id: string; runId: PersistedBudget['runId']; inputTokens: number; requestedOutputTokens: number }>): Promise<Readonly<{ id: string; grantedOutputTokens: number }>> {
    return this.database.sql.begin(async (sql) => {
      const budget = (await sql<BudgetRow[]>`select run_id, max_calls, max_input_tokens, max_output_tokens, used_calls, used_input_tokens, used_output_tokens from run_budgets where run_id = ${input.runId} for update`)[0];
      if (budget === undefined || budget.used_calls >= budget.max_calls || budget.used_input_tokens + input.inputTokens > budget.max_input_tokens) throw new DomainConflictError('Run budget is exhausted');
      const grantedOutputTokens = Math.min(input.requestedOutputTokens, budget.max_output_tokens - budget.used_output_tokens);
      if (grantedOutputTokens <= 0) throw new DomainConflictError('Run output budget is exhausted');
      await sql`update run_budgets set used_calls = used_calls + 1, used_input_tokens = used_input_tokens + ${input.inputTokens}, used_output_tokens = used_output_tokens + ${grantedOutputTokens} where run_id = ${input.runId}`;
      await sql`insert into run_budget_reservations (id, run_id, reserved_output_tokens, status) values (${input.id}, ${input.runId}, ${grantedOutputTokens}, 'reserved')`;
      return { id: input.id, grantedOutputTokens };
    });
  }
  public async settle(input: Readonly<{ id: string; actualOutputTokens?: number | undefined; possibleDuplicate: boolean }>): Promise<void> {
    await this.database.sql.begin(async (sql) => {
      const reservation = (await sql<{ run_id: string; reserved_output_tokens: number }[]>`select run_id, reserved_output_tokens from run_budget_reservations where id = ${input.id} and status = 'reserved' for update`)[0];
      if (reservation === undefined) return;
      const actual = input.actualOutputTokens ?? reservation.reserved_output_tokens;
      await sql`update run_budgets set used_output_tokens = used_output_tokens - ${reservation.reserved_output_tokens} + ${actual} where run_id = ${reservation.run_id}`;
      await sql`update run_budget_reservations set status = ${input.possibleDuplicate ? 'possible_duplicate' : 'settled'}, actual_output_tokens = ${actual}, settled_at = now() where id = ${input.id} and status = 'reserved'`;
    });
  }
  public async release(id: string): Promise<void> {
    await this.database.sql.begin(async (sql) => {
      const reservation = (await sql<{ run_id: string; reserved_output_tokens: number }[]>`select run_id, reserved_output_tokens from run_budget_reservations where id = ${id} and status = 'reserved' for update`)[0];
      if (reservation === undefined) return;
      await sql`update run_budgets set used_output_tokens = used_output_tokens - ${reservation.reserved_output_tokens} where run_id = ${reservation.run_id}`;
      await sql`update run_budget_reservations set status = 'released', settled_at = now() where id = ${id} and status = 'reserved'`;
    });
  }
}
