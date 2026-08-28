import type { WorkflowCommand } from '@slacato/core';
import { DomainConflictError, DomainNotFoundError, transitionRun, type ApprovalDecisionInput, type CommitStepInput, type StartRunInput, type StepLease, type WorkflowRun, type WorkflowStore } from '@slacato/core';
import type { JSONValue, Sql, TransactionSql } from 'postgres';
import type { DatabaseClient } from '../client.js';

type RunRow = Readonly<{ id: string; opportunity_id: string; requested_by: string; status: WorkflowRun['status']; version: number; generation_provider: string; generation_model: string }>;
type InvocationRow = Readonly<{ id: string; run_id: string; step: string; owner: string; lease_token: string; causal_command_id: string; lease_expires_at: string | Date; attempt: number }>;

type SqlExecutor = Sql | TransactionSql;

function jsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}
function jsonText(value: unknown): string { return JSON.stringify(jsonValue(value)); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function asRun(row: RunRow): WorkflowRun {
  return { id: row.id as WorkflowRun['id'], opportunityId: row.opportunity_id as WorkflowRun['opportunityId'], requestedBy: row.requested_by as WorkflowRun['requestedBy'], status: row.status, version: row.version, generationProvider: row.generation_provider, generationModel: row.generation_model };
}
function asLease(row: InvocationRow): StepLease {
  return { invocationId: row.id, causalCommandId: row.causal_command_id, runId: row.run_id as StepLease['runId'], step: row.step, owner: row.owner, leaseToken: row.lease_token, leaseExpiresAt: new Date(row.lease_expires_at), attempt: row.attempt };
}
async function insertCommand(sql: SqlExecutor, command: WorkflowCommand): Promise<void> {
  const existing = await sql<{ id: string; run_id: string; type: string; payload: Record<string, unknown>; idempotency_key: string }[]>`select id, run_id, type, payload, idempotency_key from outbox_commands where id = ${command.id} or idempotency_key = ${command.idempotencyKey} for update`;
  if (existing.length > 0) {
    const row = existing[0];
    if (row === undefined || row.id !== command.id || row.run_id !== command.runId || row.type !== command.type || row.idempotency_key !== command.idempotencyKey || canonicalJson(row.payload) !== canonicalJson(command.payload)) throw new DomainConflictError('Outbox idempotency key conflicts with another command');
    return;
  }
  await sql`insert into outbox_commands (id, run_id, type, payload, idempotency_key)
    values (${command.id}, ${command.runId}, ${command.type}, ${jsonText(command.payload)}::jsonb, ${command.idempotencyKey})
    on conflict (idempotency_key) do nothing`;
}
async function appendEvent(sql: SqlExecutor, runId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await sql`insert into run_events (id, run_id, sequence, type, payload)
    select ${`event_${crypto.randomUUID()}`}, ${runId}, coalesce(max(sequence), 0) + 1, ${type}, ${jsonText(payload)}::jsonb
    from run_events where run_id = ${runId}`;
}

/** PostgreSQL authority for atomic, CAS-protected workflow state and command transitions. */
export class PostgresWorkflowStore implements WorkflowStore {
  public constructor(private readonly database: DatabaseClient) {}

  public async startRun(input: StartRunInput): Promise<WorkflowRun> {
    if (input.command.runId !== input.id) throw new DomainConflictError('Outbox command run does not match workflow run');
    return this.database.sql.begin(async (sql) => {
      const inserted = await sql<RunRow[]>`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, version)
        values (${input.id}, ${input.opportunityId}, ${input.requestedBy}, ${input.status}, ${input.generationProvider}, ${input.generationModel}, 0)
        on conflict (id) do nothing returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model`;
      const row = inserted[0] ?? (await sql<RunRow[]>`select id, opportunity_id, requested_by, status, version, generation_provider, generation_model from runs where id = ${input.id} for update`)[0];
      if (row === undefined) throw new DomainNotFoundError('run');
      if (row.opportunity_id !== input.opportunityId || row.requested_by !== input.requestedBy) throw new DomainConflictError('Run ID is already bound to another request');
      if (inserted.length === 0 && (row.status !== input.status || row.generation_provider !== input.generationProvider || row.generation_model !== input.generationModel)) throw new DomainConflictError('Run ID is already bound to another workflow configuration');
      if (inserted.length === 1) {
        await insertCommand(sql, input.command);
        await appendEvent(sql, input.id, 'run_created', { status: input.status });
      }
      return asRun(row);
    });
  }

  public async claimStep(input: Readonly<{ runId: WorkflowRun['id']; step: string; invocationId: string; causalCommandId: string; owner: string; leaseMs: number; now?: Date }>): Promise<StepLease | undefined> {
    const now = input.now ?? new Date();
    const expires = new Date(now.getTime() + input.leaseMs);
    return this.database.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`${input.runId}:${input.step}`}))`;
      const command = await sql<{ id: string }[]>`select id from outbox_commands where id = ${input.causalCommandId} and run_id = ${input.runId} and status = 'published' and consumed_at is null for update`;
      if (command.length !== 1) throw new DomainConflictError('Causal command is not available for invocation');
      const activeForCommand = (await sql<InvocationRow[]>`select id, run_id, step, owner, lease_token, causal_command_id, lease_expires_at, attempt from step_invocations where causal_command_id = ${input.causalCommandId} and status = 'leased' order by attempt desc limit 1 for update`)[0];
      if (activeForCommand !== undefined && new Date(activeForCommand.lease_expires_at) > now) return undefined;
      if (activeForCommand !== undefined) await sql`update step_invocations set status = 'abandoned', completed_at = ${now.toISOString()}::timestamptz where id = ${activeForCommand.id} and status = 'leased'`;
      const active = await sql<InvocationRow[]>`select id, run_id, step, owner, lease_token, causal_command_id, lease_expires_at, attempt from step_invocations where run_id = ${input.runId} and step = ${input.step} and status = 'leased' order by attempt desc limit 1 for update`;
      const current = active[0];
      if (current !== undefined && new Date(current.lease_expires_at) > now) return undefined;
      if (current !== undefined && current.id !== activeForCommand?.id) await sql`update step_invocations set status = 'abandoned', completed_at = ${now.toISOString()}::timestamptz where id = ${current.id} and status = 'leased'`;
      const attempts = await sql<{ attempt: number }[]>`select coalesce(max(attempt), 0) + 1 as attempt from step_invocations where run_id = ${input.runId} and step = ${input.step}`;
      const attempt = attempts[0]?.attempt;
      if (attempt === undefined) throw new DomainConflictError('Unable to allocate step attempt');
      const leaseToken = `lease_${crypto.randomUUID()}`;
      const inserted = await sql<InvocationRow[]>`insert into step_invocations (id, run_id, step, owner, lease_token, causal_command_id, lease_expires_at, heartbeat_at, attempt)
        values (${input.invocationId}, ${input.runId}, ${input.step}, ${input.owner}, ${leaseToken}, ${input.causalCommandId}, ${expires.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz, ${attempt})
        returning id, run_id, step, owner, lease_token, causal_command_id, lease_expires_at, attempt`;
      const row = inserted[0];
      if (row === undefined) throw new DomainConflictError('Unable to claim step');
      return asLease(row);
    });
  }

  public async heartbeatStep(input: Readonly<{ invocationId: string; owner: string; leaseToken: string; leaseMs: number; now?: Date }>): Promise<StepLease | undefined> {
    const now = input.now ?? new Date();
    const expires = new Date(now.getTime() + input.leaseMs);
    const rows = await this.database.sql<InvocationRow[]>`update step_invocations set heartbeat_at = ${now.toISOString()}::timestamptz, lease_expires_at = ${expires.toISOString()}::timestamptz
      where id = ${input.invocationId} and owner = ${input.owner} and lease_token = ${input.leaseToken} and status = 'leased' and lease_expires_at > ${now.toISOString()}::timestamptz
      returning id, run_id, step, owner, lease_token, causal_command_id, lease_expires_at, attempt`;
    return rows[0] === undefined ? undefined : asLease(rows[0]);
  }

  public async commitStepAndEnqueueNext(input: CommitStepInput): Promise<WorkflowRun> {
    if (input.nextCommand.runId !== input.runId) throw new DomainConflictError('Outbox command run does not match workflow run');
    return this.database.sql.begin(async (sql) => {
      const current = (await sql<RunRow[]>`select id, opportunity_id, requested_by, status, version, generation_provider, generation_model from runs where id = ${input.runId} for update`)[0];
      if (current === undefined) throw new DomainNotFoundError('run');
      if (current.version !== input.expectedVersion) throw new DomainConflictError('Run version is stale');
      const completed = await sql<{ causal_command_id: string }[]>`update step_invocations set status = 'completed', completed_at = now()
        where id = ${input.invocationId} and run_id = ${input.runId} and owner = ${input.invocationOwner} and lease_token = ${input.leaseToken}
          and status = 'leased' and lease_expires_at > now() returning causal_command_id`;
      const invocation = completed[0];
      if (invocation === undefined) throw new DomainConflictError('Step lease is no longer owned by this worker');
      const consumed = await sql`update outbox_commands set consumed_at = now() where id = ${invocation.causal_command_id} and run_id = ${input.runId} and status = 'published' and consumed_at is null`;
      if (consumed.count !== 1) throw new DomainConflictError('Causal command was already consumed');
      const nextStatus = transitionRun(current.status, input.event);
      const updated = await sql<RunRow[]>`update runs set status = ${nextStatus}, version = version + 1, updated_at = now() where id = ${input.runId} and version = ${input.expectedVersion}
        returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model`;
      const row = updated[0];
      if (row === undefined) throw new DomainConflictError('Run version is stale');
      await sql`insert into workflow_checkpoints (id, run_id, step, payload) values (${`checkpoint_${crypto.randomUUID()}`}, ${input.runId}, ${input.event}, ${jsonText(input.checkpoint)}::jsonb) on conflict (run_id, step) do nothing`;
      if (input.artifact !== undefined) await sql`insert into specialist_artifacts (id, run_id, kind, evidence_manifest_id, content, content_hash)
        values (${input.artifact.id}, ${input.runId}, ${input.artifact.kind}, ${input.artifact.evidenceManifestId ?? null}, ${jsonText(input.artifact.content)}::jsonb, ${JSON.stringify(input.artifact.content)}) on conflict (run_id, kind) do nothing`;
      await appendEvent(sql, input.runId, input.event, { version: row.version, status: nextStatus });
      await insertCommand(sql, input.nextCommand);
      return asRun(row);
    });
  }

  public async awaitApproval(input: Readonly<{ runId: WorkflowRun['id']; expectedVersion: number; approvalSubjectId: string; subjectHash: string; payload: Readonly<Record<string, unknown>>; policyTriggers: readonly string[] }>): Promise<WorkflowRun> {
    return this.database.sql.begin(async (sql) => {
      const current = (await sql<RunRow[]>`select id, opportunity_id, requested_by, status, version, generation_provider, generation_model from runs where id = ${input.runId} for update`)[0];
      if (current === undefined) throw new DomainNotFoundError('run');
      if (current.version !== input.expectedVersion) throw new DomainConflictError('Run version is stale');
      const status = transitionRun(current.status, 'validation_requires_approval');
      const updated = await sql<RunRow[]>`update runs set status = ${status}, version = version + 1, updated_at = now() where id = ${input.runId} and version = ${input.expectedVersion} returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model`;
      const row = updated[0]; if (row === undefined) throw new DomainConflictError('Run version is stale');
      await sql`insert into approval_subjects (id, run_id, draft_version, subject_hash, payload, policy_triggers) values (${input.approvalSubjectId}, ${input.runId}, ${row.version}, ${input.subjectHash}, ${jsonText(input.payload)}::jsonb, ${jsonText(input.policyTriggers)}::jsonb)`;
      await appendEvent(sql, input.runId, 'awaiting_approval', { version: row.version, subjectHash: input.subjectHash });
      return asRun(row);
    });
  }

  public async recordDecisionAndEnqueueFinalization(input: ApprovalDecisionInput): Promise<WorkflowRun> {
    if (input.action === 'reject' && input.finalizationCommand !== undefined) throw new DomainConflictError('Rejected approvals cannot enqueue finalization');
    if (input.action !== 'reject' && input.finalizationCommand.runId !== input.runId) throw new DomainConflictError('Outbox command run does not match workflow run');
    return this.database.sql.begin(async (sql) => {
      const current = (await sql<RunRow[]>`select id, opportunity_id, requested_by, status, version, generation_provider, generation_model from runs where id = ${input.runId} for update`)[0];
      if (current === undefined) throw new DomainNotFoundError('run');
      if (current.version !== input.expectedVersion) throw new DomainConflictError('Run version is stale');
      const subject = (await sql<{ run_id: string; draft_version: number }[]>`select subject.run_id, subject.draft_version from approval_subjects subject where subject.id = ${input.approvalSubjectId} and subject.run_id = ${input.runId} for update`)[0];
      if (subject === undefined || subject.draft_version !== current.version) throw new DomainConflictError('Approval subject is not current for this run');
      const priorDecision = await sql<{ id: string }[]>`select id from approval_decisions where approval_subject_id = ${input.approvalSubjectId} for update`;
      if (priorDecision.length > 0) throw new DomainConflictError('Approval subject already has a decision');
      const event = input.action === 'reject' ? 'approval_rejected' : 'approval_granted';
      const status = transitionRun(current.status, event);
      const updated = await sql<RunRow[]>`update runs set status = ${status}, version = version + 1, updated_at = now() where id = ${input.runId} and version = ${input.expectedVersion} returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model`;
      const row = updated[0]; if (row === undefined) throw new DomainConflictError('Run version is stale');
      await sql`insert into approval_decisions (id, approval_subject_id, action, actor_id, rationale, edited_payload) values (${`decision_${crypto.randomUUID()}`}, ${input.approvalSubjectId}, ${input.action}, ${input.actorId}, ${input.rationale ?? null}, ${input.editedPayload === undefined ? null : jsonText(input.editedPayload)}::jsonb)`;
      await appendEvent(sql, input.runId, event, { version: row.version, approvalSubjectId: input.approvalSubjectId });
      if (input.action !== 'reject') await insertCommand(sql, input.finalizationCommand);
      return asRun(row);
    });
  }
}
