import { ProviderAttemptFinalizationConflict, type ProviderAttemptLedger, type ProviderAttemptReservation, type RunBudgetLimits } from '@slacato/core';
import type { TransactionSql } from 'postgres';
import type { DatabaseClient } from '../client.js';

type BudgetRow = Readonly<{ run_id: string; max_calls: number; max_input_tokens: number; max_output_tokens: number; deadline_ms: number; used_calls: number; used_input_tokens: number; used_output_tokens: number; reserved_output_tokens: number }>;
type ReservationRow = Readonly<{
  id: string; attempt_id: string; run_id: string; granted_output_tokens: number; reserved_input_tokens: number;
  status: 'reserved' | 'settled' | 'released' | 'possible_duplicate'; actual_input_tokens: number | null; actual_output_tokens: number | null;
  request_id: string | null; response_id: string | null; failure_category: string | null; failure_code: string | null;
}>;
type QuerySql = DatabaseClient['sql'] | TransactionSql;

function same(left: string | number | null | undefined, right: string | number | null | undefined): boolean { return (left ?? null) === (right ?? null); }
/** PostgreSQL is the sole durable authority for provider-call attempts and run budgets. */
export class PostgresProviderAttemptLedger implements ProviderAttemptLedger {
  public constructor(private readonly database: DatabaseClient) {}

  /** Verifies the atomically-created workflow budget before exposing a run gateway. */
  public async assertRunBudget(input: Pick<RunBudgetLimits, 'scope' | 'maxCalls' | 'maxInputTokens' | 'maxOutputTokens' | 'deadlineMs'>): Promise<void> {
    const budget = (await this.database.sql<Pick<BudgetRow, 'max_calls' | 'max_input_tokens' | 'max_output_tokens' | 'deadline_ms'>[]>`select max_calls, max_input_tokens, max_output_tokens, deadline_ms from run_budgets where run_id = ${input.scope}`)[0];
    if (budget === undefined) throw new Error('Run budget does not exist');
    if (budget.max_calls !== input.maxCalls || budget.max_input_tokens !== input.maxInputTokens || budget.max_output_tokens !== input.maxOutputTokens || budget.deadline_ms !== input.deadlineMs) throw new Error('Run budget does not match the requested run scope');
  }

  public async beginAttempt(input: Parameters<ProviderAttemptLedger['beginAttempt']>[0]): Promise<ProviderAttemptReservation> {
    return this.database.sql.begin(async (sql) => {
      const budget = (await sql<BudgetRow[]>`select run_id, max_calls, max_input_tokens, max_output_tokens, used_calls, used_input_tokens, used_output_tokens, reserved_output_tokens from run_budgets where run_id = ${input.runScope} for update`)[0];
      if (budget === undefined) throw new Error('Run budget does not exist');
      const abandoned = await sql<ReservationRow[]>`select id, attempt_id, run_id, granted_output_tokens, reserved_input_tokens, status, actual_input_tokens, actual_output_tokens, request_id, response_id, failure_category, failure_code
        from run_budget_reservations where run_id = ${input.runScope} and invocation_id is not distinct from ${input.invocationId ?? null} and operation = ${input.operation} and status = 'reserved' for update`;
      for (const row of abandoned) await this.finalizePossibleDuplicate(sql, row);

      const ordinalRow = (await sql<{ ordinal: number }[]>`select coalesce(max(ordinal), 0)::integer + 1 as ordinal
        from run_budget_reservations
        where run_id = ${input.runScope} and invocation_id is not distinct from ${input.invocationId ?? null} and operation = ${input.operation}`)[0];
      if (ordinalRow === undefined) throw new Error('Could not allocate provider attempt ordinal');
      const ordinal = ordinalRow.ordinal;

      const refreshed = (await sql<BudgetRow[]>`select run_id, max_calls, max_input_tokens, max_output_tokens, used_calls, used_input_tokens, used_output_tokens, reserved_output_tokens from run_budgets where run_id = ${input.runScope} for update`)[0];
      if (refreshed === undefined || refreshed.used_calls >= refreshed.max_calls || refreshed.used_input_tokens + input.inputTokens > refreshed.max_input_tokens) throw new Error('Run budget is exhausted');
      const grant = Math.min(input.requestedOutputTokens, refreshed.max_output_tokens - refreshed.used_output_tokens - refreshed.reserved_output_tokens);
      if (grant <= 0) throw new Error('Run output budget is exhausted');
      const attemptId = crypto.randomUUID();
      const reservationId = crypto.randomUUID();
      await sql`insert into generation_attempts (id, run_id, invocation_id, operation, ordinal, status, provider, model)
        values (${attemptId}, ${input.runScope}, ${input.invocationId ?? null}, ${input.operation}, ${ordinal}, 'attempt_started', ${input.provider}, ${input.model})`;
      await sql`insert into run_budget_reservations (id, attempt_id, run_id, invocation_id, operation, ordinal, reserved_output_tokens, granted_output_tokens, reserved_input_tokens, status)
        values (${reservationId}, ${attemptId}, ${input.runScope}, ${input.invocationId ?? null}, ${input.operation}, ${ordinal}, ${grant}, ${grant}, ${input.inputTokens}, 'reserved')`;
      await sql`update run_budgets set used_calls = used_calls + 1, used_input_tokens = used_input_tokens + ${input.inputTokens}, reserved_output_tokens = reserved_output_tokens + ${grant} where run_id = ${input.runScope}`;
      return { reservationId, attemptId, ordinal, grantedOutputTokens: grant };
    });
  }

  public async settleAttempt(input: Parameters<ProviderAttemptLedger['settleAttempt']>[0]): Promise<void> {
    await this.database.sql.begin(async (sql) => {
      const row = await this.lockReservation(sql, input);
      const actualInput = input.actualInputTokens ?? row.reserved_input_tokens;
      const actualOutput = input.actualOutputTokens ?? row.granted_output_tokens;
      if (row.status !== 'reserved') {
        if (row.status === 'settled' && same(row.actual_input_tokens, actualInput) && same(row.actual_output_tokens, actualOutput) && same(row.request_id, input.requestId) && same(row.response_id, input.responseId)) return;
        throw new ProviderAttemptFinalizationConflict();
      }
      await sql`update run_budgets set used_input_tokens = used_input_tokens + greatest(0, ${actualInput}::integer - ${row.reserved_input_tokens}::integer), used_output_tokens = used_output_tokens + ${actualOutput}, reserved_output_tokens = reserved_output_tokens - ${row.granted_output_tokens} where run_id = ${row.run_id}`;
      await sql`update run_budget_reservations set status = 'settled', actual_input_tokens = ${actualInput}, actual_output_tokens = ${actualOutput}, request_id = ${input.requestId ?? null}, response_id = ${input.responseId ?? null}, settled_at = now() where id = ${row.id}`;
      await sql`update generation_attempts set status = 'completed', possible_duplicate = false, request_id = ${input.requestId ?? null}, response_id = ${input.responseId ?? null}, input_tokens = ${actualInput}, output_tokens = ${actualOutput}, completed_at = now() where id = ${row.attempt_id}`;
    });
  }

  public async releaseAttempt(input: Parameters<ProviderAttemptLedger['releaseAttempt']>[0]): Promise<void> {
    await this.database.sql.begin(async (sql) => {
      const row = await this.lockReservation(sql, input);
      const status = input.disposition === 'safe_not_sent' ? 'released' : 'possible_duplicate';
      const output = input.disposition === 'safe_not_sent' ? null : row.granted_output_tokens;
      if (row.status !== 'reserved') {
        if (row.status === status && same(row.actual_output_tokens, output) && same(row.failure_category, input.category) && same(row.failure_code, input.diagnosticCode)) return;
        throw new ProviderAttemptFinalizationConflict();
      }
      await sql`update run_budgets set reserved_output_tokens = reserved_output_tokens - ${row.granted_output_tokens}, used_output_tokens = used_output_tokens + ${output ?? 0} where run_id = ${row.run_id}`;
      await sql`update run_budget_reservations set status = ${status}, actual_output_tokens = ${output}, failure_category = ${input.category ?? null}, failure_code = ${input.diagnosticCode ?? null}, settled_at = now() where id = ${row.id}`;
      await sql`update generation_attempts set status = ${input.disposition === 'safe_not_sent' ? 'failed' : 'possible_duplicate'}, possible_duplicate = ${input.disposition === 'possibly_sent'}, output_tokens = ${output}, completed_at = now() where id = ${row.attempt_id}`;
    });
  }

  private async lockReservation(sql: QuerySql, input: ProviderAttemptReservation): Promise<ReservationRow> {
    const row = (await sql<ReservationRow[]>`select id, attempt_id, run_id, granted_output_tokens, reserved_input_tokens, status, actual_input_tokens, actual_output_tokens, request_id, response_id, failure_category, failure_code from run_budget_reservations where id = ${input.reservationId} and attempt_id = ${input.attemptId} for update`)[0];
    if (row === undefined) throw new ProviderAttemptFinalizationConflict('Unknown provider attempt reservation');
    return row;
  }

  private async finalizePossibleDuplicate(sql: QuerySql, row: ReservationRow): Promise<void> {
    await sql`update run_budgets set reserved_output_tokens = reserved_output_tokens - ${row.granted_output_tokens}, used_output_tokens = used_output_tokens + ${row.granted_output_tokens} where run_id = ${row.run_id}`;
    await sql`update run_budget_reservations set status = 'possible_duplicate', actual_output_tokens = ${row.granted_output_tokens}, settled_at = now() where id = ${row.id}`;
    await sql`update generation_attempts set status = 'possible_duplicate', possible_duplicate = true, output_tokens = ${row.granted_output_tokens}, completed_at = now() where id = ${row.attempt_id}`;
  }
}
