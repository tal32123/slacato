import type { GenerationAttemptStore } from '@slacato/core';
import type { DatabaseClient } from '../client.js';

/** Writes `attempt_started` before a provider call and settles safe IDs/usage after it returns. */
export class PostgresGenerationAttemptStore implements GenerationAttemptStore {
  public constructor(private readonly database: DatabaseClient) {}
  public async recordAttemptStarted(input: Parameters<GenerationAttemptStore['recordAttemptStarted']>[0]): Promise<void> {
    await this.database.sql`insert into generation_attempts (id, run_id, invocation_id, operation, status, provider, model)
      values (${input.id}, ${input.runId}, ${input.invocationId ?? null}, ${input.operation}, 'attempt_started', ${input.provider}, ${input.model}) on conflict (id) do nothing`;
  }
  public async completeAttempt(input: Parameters<GenerationAttemptStore['completeAttempt']>[0]): Promise<void> {
    await this.database.sql`update generation_attempts set status = ${input.status}, request_id = ${input.requestId ?? null}, response_id = ${input.responseId ?? null}, input_tokens = ${input.inputTokens ?? null}, output_tokens = ${input.outputTokens ?? null}, possible_duplicate = ${input.possibleDuplicate}, completed_at = now() where id = ${input.id} and status = 'attempt_started'`;
  }
}
