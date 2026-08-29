import { createHash } from 'node:crypto';
import { ProviderAttemptFinalizationConflict, type ProviderAttemptLedger, type ProviderAttemptReservation, type RunBudgetLimits } from '@slacato/core';
import type { TransactionSql } from 'postgres';
import type { DatabaseClient } from '../client.js';
import { logger } from '../../logging/logger.js';

type BudgetRow = Readonly<{ run_id: string; max_calls: number; deadline_ms: number | null; deadline_at: string | Date; used_calls: number; used_input_tokens: number; used_output_tokens: number; reserved_output_tokens: number }>;
type ReservationRow = Readonly<{
  id: string; attempt_id: string; run_id: string; granted_output_tokens: number; reserved_input_tokens: number;
  status: 'reserved' | 'settled' | 'released' | 'possible_duplicate'; actual_input_tokens: number | null; actual_output_tokens: number | null;
  request_id: string | null; response_id: string | null; failure_category: string | null; failure_code: string | null;
}>;
type AttemptLogRow = Readonly<{ run_id: string; provider: string; model: string; ordinal: number; started_at: Date | string }>;
type QuerySql = DatabaseClient['sql'] | TransactionSql;

/** Compares nullable provider-attempt values using a shared null-equivalence rule. */
function same(left: string | number | null | undefined, right: string | number | null | undefined): boolean { return (left ?? null) === (right ?? null); }
/** PostgreSQL is the sole durable authority for provider-call attempts and execution safeguards. */
export class PostgresProviderAttemptLedger implements ProviderAttemptLedger {
  /** Creates a provider-attempt ledger backed by the supplied database client. */
  public constructor(private readonly database: DatabaseClient) {}

  /** Verifies the atomically-created call/deadline safeguards before exposing a run gateway. */
  public async assertRunBudget(input: RunBudgetLimits): Promise<void> {
    await this.database.sql`update run_budgets set deadline_ms = ${input.deadlineMs}
      where run_id = ${input.scope} and deadline_ms is null and max_calls = ${input.maxCalls}`;
    const budget = (await this.database.sql<Pick<BudgetRow, 'max_calls' | 'deadline_ms' | 'deadline_at'>[]>`select max_calls, deadline_ms, deadline_at from run_budgets
      where run_id = ${input.scope}
        and max_calls = ${input.maxCalls}
        and deadline_ms = ${input.deadlineMs}`)[0];
    if (budget === undefined) {
      const exists = await this.database.sql<{ exists: boolean }[]>`select exists(select 1 from run_budgets where run_id = ${input.scope}) as exists`;
      if (exists[0]?.exists === true) throw new Error('Run budget does not match the requested run scope');
      throw new Error('Run budget does not exist');
    }
    if (budget.deadline_ms !== input.deadlineMs) throw new Error('Run budget does not match the requested run scope');
    if (new Date(budget.deadline_at).getTime() <= Date.now()) throw new Error('Shared run deadline reached');
  }

  /** Returns the unexpired execution time remaining for a run budget. */
  public async remainingDeadlineMs(runScope: string): Promise<number> {
    const deadline = (await this.database.sql<{ deadline_at: Date | string }[]>`select deadline_at from run_budgets where run_id = ${runScope}`)[0]?.deadline_at;
    if (deadline === undefined) throw new Error('Run budget does not exist');
    const remaining = new Date(deadline).getTime() - Date.now();
    if (remaining <= 0) throw new Error('Shared run deadline reached');
    return remaining;
  }

  /** Reserves capacity and records the start of a provider attempt atomically. */
  public async beginAttempt(input: Parameters<ProviderAttemptLedger['beginAttempt']>[0]): Promise<ProviderAttemptReservation> {
    const outcome = await this.database.sql.begin(async (sql) => {
      const logicalGenerationId = input.logicalGenerationId ?? `generation_${createHash('sha256').update(`${input.runScope}\u0000${input.operation}`).digest('hex')}`;
      const budget = (await sql<BudgetRow[]>`select run_id, max_calls, deadline_ms, deadline_at, used_calls, used_input_tokens, used_output_tokens, reserved_output_tokens from run_budgets where run_id = ${input.runScope} for update`)[0];
      if (budget === undefined) throw new Error('Run budget does not exist');
      if (new Date(budget.deadline_at).getTime() <= Date.now()) throw new Error('Shared run deadline reached');
      const abandoned = await sql<ReservationRow[]>`select id, attempt_id, run_id, granted_output_tokens, reserved_input_tokens, status, actual_input_tokens, actual_output_tokens, request_id, response_id, failure_category, failure_code
        from run_budget_reservations where run_id = ${input.runScope} and logical_generation_id = ${logicalGenerationId} and operation = ${input.operation} and status = 'reserved' for update`;
      const recovered = [];
      for (const row of abandoned) {
        recovered.push({ attempt: await this.finalizePossibleDuplicate(sql, row), row });
      }

      const ordinalRow = (await sql<{ ordinal: number }[]>`select coalesce(max(ordinal), 0)::integer + 1 as ordinal
        from run_budget_reservations
        where run_id = ${input.runScope} and logical_generation_id = ${logicalGenerationId} and operation = ${input.operation}`)[0];
      if (ordinalRow === undefined) throw new Error('Could not allocate provider attempt ordinal');
      const ordinal = ordinalRow.ordinal;

      const refreshed = (await sql<BudgetRow[]>`select run_id, max_calls, deadline_ms, deadline_at, used_calls, used_input_tokens, used_output_tokens, reserved_output_tokens from run_budgets where run_id = ${input.runScope} for update`)[0];
      if (refreshed === undefined || refreshed.used_calls >= refreshed.max_calls) throw new Error('Run call limit is exhausted');
      const grant = 1;
      const attemptId = crypto.randomUUID();
      const reservationId = crypto.randomUUID();
      await sql`insert into generation_attempts (id, run_id, invocation_id, logical_generation_id, operation, ordinal, status, provider, model)
        values (${attemptId}, ${input.runScope}, ${input.invocationId ?? null}, ${logicalGenerationId}, ${input.operation}, ${ordinal}, 'attempt_started', ${input.provider}, ${input.model})`;
      await sql`insert into run_budget_reservations (id, attempt_id, run_id, invocation_id, logical_generation_id, operation, ordinal, reserved_output_tokens, granted_output_tokens, reserved_input_tokens, status)
        values (${reservationId}, ${attemptId}, ${input.runScope}, ${input.invocationId ?? null}, ${logicalGenerationId}, ${input.operation}, ${ordinal}, ${grant}, ${grant}, ${input.inputTokens}, 'reserved')`;
      await sql`update run_budgets set used_calls = used_calls + 1, used_input_tokens = used_input_tokens + ${input.inputTokens}, reserved_output_tokens = reserved_output_tokens + ${grant} where run_id = ${input.runScope}`;
      return { reservation: { reservationId, attemptId, ordinal, grantedOutputTokens: grant }, recovered };
    });
    for (const recovered of outcome.recovered) {
      logger.error({
        event: 'provider_attempt_failed', correlationId: recovered.row.attempt_id, runId: recovered.attempt.run_id,
        attemptId: recovered.row.attempt_id, status: 'possible_duplicate',
        provider: recovered.attempt.provider, model: recovered.attempt.model,
        durationMs: Math.max(0, Date.now() - new Date(recovered.attempt.started_at).getTime()),
        retryCount: recovered.attempt.ordinal - 1, inputTokens: recovered.row.reserved_input_tokens,
        outputTokens: recovered.row.granted_output_tokens, errorCode: 'ABANDONED_PROVIDER_ATTEMPT'
      });
    }
    const reservation = outcome.reservation;
    logger.info({
      event: 'provider_attempt_started', correlationId: reservation.attemptId, runId: input.runScope,
      attemptId: reservation.attemptId, status: 'started', provider: input.provider, model: input.model,
      durationMs: 0, retryCount: reservation.ordinal - 1, inputTokens: input.inputTokens, outputTokens: 0
    });
    return reservation;
  }

  /** Settles a reserved provider attempt with its observed token usage and identifiers. */
  public async settleAttempt(input: Parameters<ProviderAttemptLedger['settleAttempt']>[0]): Promise<void> {
    const completed = await this.database.sql.begin(async (sql) => {
      const row = await this.lockReservation(sql, input);
      const actualInput = input.actualInputTokens ?? row.reserved_input_tokens;
      const actualOutput = input.actualOutputTokens ?? row.granted_output_tokens;
      if (row.status !== 'reserved') {
        if (row.status === 'settled' && same(row.actual_input_tokens, actualInput) && same(row.actual_output_tokens, actualOutput) && same(row.request_id, input.requestId) && same(row.response_id, input.responseId)) return undefined;
        throw new ProviderAttemptFinalizationConflict();
      }
      await sql`update run_budgets set used_input_tokens = used_input_tokens + greatest(0, ${actualInput}::integer - ${row.reserved_input_tokens}::integer), used_output_tokens = used_output_tokens + ${actualOutput}, reserved_output_tokens = reserved_output_tokens - ${row.granted_output_tokens} where run_id = ${row.run_id}`;
      await sql`update run_budget_reservations set status = 'settled', actual_input_tokens = ${actualInput}, actual_output_tokens = ${actualOutput}, request_id = ${input.requestId ?? null}, response_id = ${input.responseId ?? null}, settled_at = now() where id = ${row.id}`;
      const attempt = (await sql<AttemptLogRow[]>`update generation_attempts set status = 'completed', possible_duplicate = false, request_id = ${input.requestId ?? null}, response_id = ${input.responseId ?? null}, input_tokens = ${actualInput}, output_tokens = ${actualOutput}, completed_at = now() where id = ${row.attempt_id}
        returning run_id, provider, model, ordinal, started_at`)[0];
      if (attempt === undefined) throw new ProviderAttemptFinalizationConflict('Unknown provider attempt');
      return { attempt, actualInput, actualOutput };
    });
    if (completed === undefined) return;
    logger.info({
      event: 'provider_attempt_completed', correlationId: input.attemptId, runId: completed.attempt.run_id,
      attemptId: input.attemptId, status: 'completed', provider: completed.attempt.provider, model: completed.attempt.model,
      durationMs: Math.max(0, Date.now() - new Date(completed.attempt.started_at).getTime()),
      retryCount: completed.attempt.ordinal - 1, inputTokens: completed.actualInput, outputTokens: completed.actualOutput
    });
  }

  /** Releases a provider-attempt reservation according to whether the request may have been sent. */
  public async releaseAttempt(input: Parameters<ProviderAttemptLedger['releaseAttempt']>[0]): Promise<void> {
    const failed = await this.database.sql.begin(async (sql) => {
      const row = await this.lockReservation(sql, input);
      const status = input.disposition === 'safe_not_sent' ? 'released' : 'possible_duplicate';
      const output = input.disposition === 'safe_not_sent' ? null : row.granted_output_tokens;
      if (row.status !== 'reserved') {
        if (row.status === status && same(row.actual_output_tokens, output) && same(row.failure_category, input.category) && same(row.failure_code, input.diagnosticCode)) return undefined;
        throw new ProviderAttemptFinalizationConflict();
      }
      await sql`update run_budgets set reserved_output_tokens = reserved_output_tokens - ${row.granted_output_tokens}, used_output_tokens = used_output_tokens + ${output ?? 0} where run_id = ${row.run_id}`;
      await sql`update run_budget_reservations set status = ${status}, actual_output_tokens = ${output}, failure_category = ${input.category ?? null}, failure_code = ${input.diagnosticCode ?? null}, settled_at = now() where id = ${row.id}`;
      const attempt = (await sql<AttemptLogRow[]>`update generation_attempts set status = ${input.disposition === 'safe_not_sent' ? 'failed' : 'possible_duplicate'}, possible_duplicate = ${input.disposition === 'possibly_sent'}, output_tokens = ${output}, completed_at = now() where id = ${row.attempt_id}
        returning run_id, provider, model, ordinal, started_at`)[0];
      if (attempt === undefined) throw new ProviderAttemptFinalizationConflict('Unknown provider attempt');
      return { attempt, output, inputTokens: row.reserved_input_tokens };
    });
    if (failed === undefined) return;
    const diagnosticCode = input.diagnosticCode?.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 128);
    logger.error({
      event: 'provider_attempt_failed', correlationId: input.attemptId, runId: failed.attempt.run_id,
      attemptId: input.attemptId, status: input.disposition === 'safe_not_sent' ? 'failed' : 'possible_duplicate',
      provider: failed.attempt.provider, model: failed.attempt.model,
      durationMs: Math.max(0, Date.now() - new Date(failed.attempt.started_at).getTime()),
      retryCount: failed.attempt.ordinal - 1, inputTokens: failed.inputTokens, outputTokens: failed.output ?? 0,
      errorCode: diagnosticCode === undefined || diagnosticCode.length === 0 ? 'PROVIDER_ATTEMPT_FAILED' : diagnosticCode
    });
  }

  /** Records validation metadata for a provider attempt exactly once. */
  public async recordAttemptMetadata(input: Parameters<NonNullable<ProviderAttemptLedger['recordAttemptMetadata']>>[0]): Promise<void> {
    const rows = await this.database.sql<{ output_mode: string | null; validation_attempts: number; validation_issues: unknown; warnings: unknown }[]>`select output_mode, validation_attempts, validation_issues, warnings from generation_attempts where id = ${input.attemptId}`;
    const existing = rows[0];
    if (existing === undefined) throw new ProviderAttemptFinalizationConflict('Unknown provider attempt');
    if (existing.output_mode !== null) {
      if (existing.output_mode === input.outputMode && existing.validation_attempts === input.validationAttempts
        && JSON.stringify(existing.validation_issues) === JSON.stringify(input.validationIssues) && JSON.stringify(existing.warnings) === JSON.stringify(input.warnings)) return;
      throw new ProviderAttemptFinalizationConflict('Provider attempt metadata was already recorded differently');
    }
    await this.database.sql`update generation_attempts set output_mode = ${input.outputMode}, validation_attempts = ${input.validationAttempts},
      validation_issues = ${JSON.stringify(input.validationIssues)}::jsonb, warnings = ${JSON.stringify(input.warnings)}::jsonb
      where id = ${input.attemptId} and output_mode is null`;
  }

  /** Locks and returns the reservation identified by the supplied attempt handles. */
  private async lockReservation(sql: QuerySql, input: ProviderAttemptReservation): Promise<ReservationRow> {
    const row = (await sql<ReservationRow[]>`select id, attempt_id, run_id, granted_output_tokens, reserved_input_tokens, status, actual_input_tokens, actual_output_tokens, request_id, response_id, failure_category, failure_code from run_budget_reservations where id = ${input.reservationId} and attempt_id = ${input.attemptId} for update`)[0];
    if (row === undefined) throw new ProviderAttemptFinalizationConflict('Unknown provider attempt reservation');
    return row;
  }

  /** Finalizes an abandoned reservation as a possible duplicate while charging its reserved output. */
  private async finalizePossibleDuplicate(sql: QuerySql, row: ReservationRow): Promise<AttemptLogRow> {
    await sql`update run_budgets set reserved_output_tokens = reserved_output_tokens - ${row.granted_output_tokens}, used_output_tokens = used_output_tokens + ${row.granted_output_tokens} where run_id = ${row.run_id}`;
    await sql`update run_budget_reservations set status = 'possible_duplicate', actual_output_tokens = ${row.granted_output_tokens}, settled_at = now() where id = ${row.id}`;
    const attempt = (await sql<AttemptLogRow[]>`update generation_attempts set status = 'possible_duplicate', possible_duplicate = true, output_tokens = ${row.granted_output_tokens}, completed_at = now() where id = ${row.attempt_id}
      returning run_id, provider, model, ordinal, started_at`)[0];
    if (attempt === undefined) throw new ProviderAttemptFinalizationConflict('Unknown provider attempt');
    return attempt;
  }
}
