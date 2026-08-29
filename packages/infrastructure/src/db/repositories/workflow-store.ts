import {
  DomainConflictError, DomainNotFoundError, canonicalJson, dealBriefSchema, hashApprovalPayload, transitionRun,
  type ApprovalAuthority, type ApprovalCategory, type ApprovalDecision, type ApprovalDecisionInput, type ApprovalDecisionReplay,
  type ApprovalDecisionStoreResult, type ApprovalRequirementEntry, type ApprovalSubject, type AwaitApprovalInput, type CommitStepInput,
  type FinalizeRunInput, type RegenerateRunInput, type ReplaceApprovalSubjectInput, type SaveCheckpointInput, type StartRunInput,
  type StepLease, type WorkflowCommand, type WorkflowRun, type WorkflowStore
} from '@slacato/core';
import type { JSONValue, Sql, TransactionSql } from 'postgres';
import type { DatabaseClient } from '../client.js';

type RunRow = Readonly<{ id: string; opportunity_id: string; requested_by: string; status: WorkflowRun['status']; version: number; generation_provider: string; generation_model: string; start_request_hash?: string | undefined }>;
type InvocationRow = Readonly<{ id: string; run_id: string; step: string; owner: string; lease_token: string; causal_command_id: string; lease_expires_at: string | Date; attempt: number }>;
type SqlExecutor = Sql | TransactionSql;

function jsonValue(value: unknown): JSONValue { return JSON.parse(JSON.stringify(value)) as JSONValue; }
function jsonText(value: unknown): string { return JSON.stringify(jsonValue(value)); }
function asRun(row: RunRow): WorkflowRun { return { id: row.id as WorkflowRun['id'], opportunityId: row.opportunity_id as WorkflowRun['opportunityId'], requestedBy: row.requested_by as WorkflowRun['requestedBy'], status: row.status, version: row.version, generationProvider: row.generation_provider, generationModel: row.generation_model, startRequestHash: row.start_request_hash ?? '' }; }
function asLease(row: InvocationRow): StepLease { return { invocationId: row.id, causalCommandId: row.causal_command_id, runId: row.run_id as StepLease['runId'], step: row.step, owner: row.owner, leaseToken: row.lease_token, leaseExpiresAt: new Date(row.lease_expires_at), attempt: row.attempt }; }
async function runById(sql: SqlExecutor, id: string, lock = false): Promise<RunRow | undefined> {
  const rows = lock
    ? await sql<RunRow[]>`select id, opportunity_id, requested_by, status, version, generation_provider, generation_model, start_request_hash from runs where id = ${id} for update`
    : await sql<RunRow[]>`select id, opportunity_id, requested_by, status, version, generation_provider, generation_model, start_request_hash from runs where id = ${id}`;
  return rows[0];
}
async function insertCommand(sql: SqlExecutor, command: WorkflowCommand): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`outbox:${command.idempotencyKey}`}))`;
  const existing = await sql<{ id: string; run_id: string; type: string; payload: Record<string, unknown>; idempotency_key: string }[]>`select id, run_id, type, payload, idempotency_key from outbox_commands where id = ${command.id} or idempotency_key = ${command.idempotencyKey} for update`;
  if (existing.length > 0) {
    const row = existing[0];
    if (row === undefined || row.id !== command.id || row.run_id !== command.runId || row.type !== command.type || row.idempotency_key !== command.idempotencyKey || canonicalJson(row.payload) !== canonicalJson(command.payload)) throw new DomainConflictError('Outbox idempotency key conflicts with another command');
    return;
  }
  await sql`insert into outbox_commands (id, run_id, type, payload, idempotency_key) values (${command.id}, ${command.runId}, ${command.type}, ${jsonText(command.payload)}::jsonb, ${command.idempotencyKey})`;
}
async function appendEvent(sql: SqlExecutor, runId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await sql`insert into run_events (id, run_id, sequence, type, payload)
    select ${`event_${crypto.randomUUID()}`}, ${runId}, coalesce(max(sequence), 0) + 1, ${type}, ${jsonText(payload)}::jsonb from run_events where run_id = ${runId}`;
}
async function replayDecision(sql: SqlExecutor, input: Readonly<{ idempotencyKey: string; requestHash: string }>): Promise<ApprovalDecisionReplay | undefined> {
  const decision = (await sql<{
    approval_subject_id: string; entry_id: string; approved_subject_hash: string; action: ApprovalDecision['action'];
    request_hash: string; run_id: string; superseded_by_subject_id: string | null;
    result_run_version: number; result_status: 'awaiting_approval' | 'finalizing' | 'rejected';
    result_quorum_satisfied: boolean; result_rejected: boolean;
  }[]>`select decision.approval_subject_id, decision.entry_id, decision.approved_subject_hash, decision.action,
    decision.request_hash, decision.result_run_version, decision.result_status,
    decision.result_quorum_satisfied, decision.result_rejected, subject.run_id, subject.superseded_by_subject_id
    from approval_decisions decision
    join approval_subjects subject on subject.id = decision.approval_subject_id
    where decision.idempotency_key = ${input.idempotencyKey}`)[0];
  if (decision === undefined) return undefined;
  if (decision.request_hash !== input.requestHash) throw new DomainConflictError('Decision idempotency key conflicts with another decision');
  const currentRun = await runById(sql, decision.run_id);
  if (currentRun === undefined) throw new DomainNotFoundError('run');
  const approvalSubjectId = decision.action === 'edit_and_approve'
    ? decision.superseded_by_subject_id
    : decision.approval_subject_id;
  if (approvalSubjectId === null) throw new DomainConflictError('Replacement approval subject is unavailable');
  return {
    run: { ...asRun(currentRun), status: decision.result_status, version: decision.result_run_version },
    approvalSubjectId,
    entryId: decision.entry_id,
    approvedSubjectHash: decision.approved_subject_hash,
    quorumSatisfied: decision.result_quorum_satisfied,
    rejected: decision.result_rejected
  };
}
async function ownLease(sql: SqlExecutor, input: Readonly<{ invocationId: string; invocationOwner: string; leaseToken: string }>): Promise<void> {
  const rows = await sql<{ id: string }[]>`select id from step_invocations where id = ${input.invocationId} and owner = ${input.invocationOwner} and lease_token = ${input.leaseToken} and status = 'leased' and lease_expires_at > now() for update`;
  if (rows.length !== 1) throw new DomainConflictError('Step lease is no longer owned by this worker');
}
async function completeLease(sql: SqlExecutor, input: Readonly<{ runId: string; invocationId: string; invocationOwner: string; leaseToken: string; causalCommandId?: string | undefined }>): Promise<string> {
  const rows = await sql<{ causal_command_id: string }[]>`update step_invocations set status = 'completed', completed_at = now()
    where id = ${input.invocationId} and run_id = ${input.runId} and owner = ${input.invocationOwner} and lease_token = ${input.leaseToken}
      and status = 'leased' and lease_expires_at > now() returning causal_command_id`;
  const commandId = rows[0]?.causal_command_id;
  if (commandId === undefined || (input.causalCommandId !== undefined && commandId !== input.causalCommandId)) throw new DomainConflictError('Step lease is no longer owned by this worker');
  const consumed = await sql`update outbox_commands set consumed_at = now() where id = ${commandId} and run_id = ${input.runId} and status = 'published' and consumed_at is null`;
  if (consumed.count !== 1) throw new DomainConflictError('Causal command was already consumed');
  return commandId;
}
async function storeCheckpoint(sql: SqlExecutor, input: Readonly<{ runId: string; step: string; invocationId?: string | undefined; logicalGenerationId?: string | undefined; checkpoint: Readonly<Record<string, unknown>> }>): Promise<void> {
  const rows = await sql<{ payload: Record<string, unknown>; logical_generation_id: string | null }[]>`select payload, logical_generation_id from workflow_checkpoints where run_id = ${input.runId} and step = ${input.step} for update`;
  const existing = rows[0];
  if (existing !== undefined) {
    if (canonicalJson(existing.payload) !== canonicalJson(input.checkpoint) || (existing.logical_generation_id ?? undefined) !== input.logicalGenerationId) throw new DomainConflictError('Checkpoint replay conflicts with persisted content');
    return;
  }
  await sql`insert into workflow_checkpoints (id, run_id, step, invocation_id, logical_generation_id, payload) values
    (${`checkpoint_${crypto.randomUUID()}`}, ${input.runId}, ${input.step}, ${input.invocationId ?? null}, ${input.logicalGenerationId ?? null}, ${jsonText(input.checkpoint)}::jsonb)`;
}
async function persistGeneratedArtifact(sql: SqlExecutor, input: SaveCheckpointInput): Promise<void> {
  if (input.logicalGenerationId === undefined || (!input.step.startsWith('specialist:') && input.step !== 'strategy')) return;
  const value = input.checkpoint.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DomainConflictError('Generated checkpoint has no object artifact');
  const status = input.checkpoint.status === 'degraded' ? 'degraded' : input.checkpoint.status === 'failed' ? 'failed' : 'success';
  const warnings = typeof input.checkpoint.warning === 'string' ? [input.checkpoint.warning] : [];
  const existing = await sql<{ content_hash: string; outcome: string; generation_metadata: Record<string, unknown> }[]>`select content_hash, outcome, generation_metadata from specialist_artifacts where logical_generation_id = ${input.logicalGenerationId} for update`;
  const contentHash = hashApprovalPayload(value);
  if (existing[0] !== undefined) {
    if (existing[0].content_hash !== contentHash || existing[0].outcome !== status || canonicalJson(existing[0].generation_metadata) !== canonicalJson(input.checkpoint.generation ?? {})) throw new DomainConflictError('Generated artifact replay conflicts with persisted content');
    return;
  }
  await sql`insert into specialist_artifacts (id, run_id, kind, draft_version, outcome, warnings, logical_generation_id, generation_metadata, content, content_hash)
    values (${`artifact_${hashApprovalPayload(input.logicalGenerationId)}`}, ${input.runId}, ${input.step.replace('specialist:', '')}, 0, ${status}, ${jsonText(warnings)}::jsonb,
      ${input.logicalGenerationId}, ${jsonText(input.checkpoint.generation ?? {})}::jsonb, ${jsonText(value)}::jsonb, ${contentHash})`;
}

/** PostgreSQL authority for atomic, CAS-protected workflow state, checkpoints, approvals, and outbox transitions. */
export class PostgresWorkflowStore implements WorkflowStore {
  public constructor(private readonly database: DatabaseClient) {}

  public async findRunByIdempotencyKey(input: Readonly<{ idempotencyKey: string; requestedBy: WorkflowRun['requestedBy']; opportunityId: WorkflowRun['opportunityId'] }>): Promise<WorkflowRun | undefined> {
    const row = (await this.database.sql<RunRow[]>`select id, opportunity_id, requested_by, status, version, generation_provider, generation_model, start_request_hash
      from runs where idempotency_key = ${input.idempotencyKey} and requested_by = ${input.requestedBy} and opportunity_id = ${input.opportunityId}`)[0];
    return row === undefined ? undefined : asRun(row);
  }
  public async findActiveRun(input: Readonly<{ opportunityId: WorkflowRun['opportunityId']; requestedBy: WorkflowRun['requestedBy'] }>): Promise<WorkflowRun | undefined> {
    const rows = await this.database.sql<RunRow[]>`select id, opportunity_id, requested_by, status, version, generation_provider, generation_model, start_request_hash
      from runs where opportunity_id = ${input.opportunityId}
      and status in ('created','retrieving','specialists_running','synthesizing','validating','awaiting_approval','finalizing') order by created_at limit 1`;
    return rows[0] === undefined ? undefined : asRun(rows[0]);
  }
  public async getRun(runId: WorkflowRun['id']): Promise<WorkflowRun | undefined> { const row = await runById(this.database.sql, runId); return row === undefined ? undefined : asRun(row); }

  public async startRun(input: StartRunInput): Promise<WorkflowRun> {
    if (input.command.runId !== input.id || input.budget.scope !== input.id) throw new DomainConflictError('Run, command, and budget scopes do not match');
    return this.database.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`active-run:${input.opportunityId}`}))`;
      const replay = (await sql<RunRow[]>`select id, opportunity_id, requested_by, status, version, generation_provider, generation_model, start_request_hash from runs
        where idempotency_key = ${input.idempotencyKey} and requested_by = ${input.requestedBy} and opportunity_id = ${input.opportunityId} for update`)[0];
      if (replay !== undefined) {
        if (replay.start_request_hash !== input.startRequestHash) throw new DomainConflictError('Start idempotency key conflicts with another command');
        return asRun(replay);
      }
      const active = (await sql<RunRow[]>`select id, opportunity_id, requested_by, status, version, generation_provider, generation_model, start_request_hash from runs
        where opportunity_id = ${input.opportunityId} and status in ('created','retrieving','specialists_running','synthesizing','validating','awaiting_approval','finalizing') for update`)[0];
      if (active !== undefined) return asRun(active);
      const rows = await sql<RunRow[]>`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, idempotency_key, start_request_hash, version)
        values (${input.id}, ${input.opportunityId}, ${input.requestedBy}, ${input.status}, ${input.generationProvider}, ${input.generationModel}, ${input.idempotencyKey}, ${input.startRequestHash}, 0)
        returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model, start_request_hash`;
      const row = rows[0]; if (row === undefined) throw new DomainConflictError('Unable to create run');
      await sql`insert into run_budgets (run_id, max_calls, max_input_tokens, max_output_tokens, deadline_ms, deadline_at) values
        (${input.id}, ${input.budget.maxCalls}, ${input.budget.maxInputTokens}, ${input.budget.maxOutputTokens}, ${input.budget.deadlineMs}, now() + (${input.budget.deadlineMs}::text || ' milliseconds')::interval)`;
      await insertCommand(sql, input.command); await appendEvent(sql, input.id, 'run_created', { status: input.status, deadlineMs: input.budget.deadlineMs }); return asRun(row);
    });
  }

  public async claimStep(input: Readonly<{ runId: WorkflowRun['id']; step: string; invocationId: string; causalCommandId: string; owner: string; leaseMs: number; now?: Date }>): Promise<StepLease | undefined> {
    const now = input.now ?? new Date(); const expires = new Date(now.getTime() + input.leaseMs);
    return this.database.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`${input.runId}:${input.step}`}))`;
      const commandRows = await sql<{ id: string }[]>`select id from outbox_commands where id = ${input.causalCommandId} and run_id = ${input.runId} and status = 'published' and consumed_at is null for update`;
      if (commandRows.length !== 1) return undefined;
      const active = (await sql<InvocationRow[]>`select id, run_id, step, owner, lease_token, causal_command_id, lease_expires_at, attempt from step_invocations where run_id = ${input.runId} and step = ${input.step} and status = 'leased' order by attempt desc limit 1 for update`)[0];
      if (active !== undefined && new Date(active.lease_expires_at) > now) return undefined;
      if (active !== undefined) await sql`update step_invocations set status = 'abandoned', completed_at = ${now.toISOString()}::timestamptz where id = ${active.id}`;
      const attempt = (await sql<{ attempt: number }[]>`select coalesce(max(attempt), 0) + 1 as attempt from step_invocations where run_id = ${input.runId} and step = ${input.step}`)[0]?.attempt;
      if (attempt === undefined) throw new DomainConflictError('Unable to allocate step attempt');
      const token = `lease_${crypto.randomUUID()}`;
      const row = (await sql<InvocationRow[]>`insert into step_invocations (id, run_id, step, owner, lease_token, causal_command_id, lease_expires_at, heartbeat_at, attempt)
        values (${input.invocationId}, ${input.runId}, ${input.step}, ${input.owner}, ${token}, ${input.causalCommandId}, ${expires.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz, ${attempt})
        returning id, run_id, step, owner, lease_token, causal_command_id, lease_expires_at, attempt`)[0];
      if (row === undefined) throw new DomainConflictError('Unable to claim step'); return asLease(row);
    });
  }
  public async heartbeatStep(input: Readonly<{ invocationId: string; owner: string; leaseToken: string; leaseMs: number; now?: Date }>): Promise<StepLease | undefined> {
    const now = input.now ?? new Date(); const expires = new Date(now.getTime() + input.leaseMs);
    const rows = await this.database.sql<InvocationRow[]>`update step_invocations set heartbeat_at = ${now.toISOString()}::timestamptz, lease_expires_at = ${expires.toISOString()}::timestamptz
      where id = ${input.invocationId} and owner = ${input.owner} and lease_token = ${input.leaseToken} and status = 'leased' and lease_expires_at > ${now.toISOString()}::timestamptz
      returning id, run_id, step, owner, lease_token, causal_command_id, lease_expires_at, attempt`;
    return rows[0] === undefined ? undefined : asLease(rows[0]);
  }
  public async abandonStep(input: Parameters<WorkflowStore['abandonStep']>[0]): Promise<void> {
    const released = await this.database.sql`update step_invocations set status = 'abandoned', completed_at = now()
      where id = ${input.invocationId} and owner = ${input.owner} and lease_token = ${input.leaseToken} and status = 'leased'`;
    if (released.count !== 1) throw new DomainConflictError('Step lease is no longer owned by this worker');
  }
  public async getCheckpoint(input: Readonly<{ runId: WorkflowRun['id']; step: string }>): Promise<Readonly<Record<string, unknown>> | undefined> {
    return (await this.database.sql<{ payload: Record<string, unknown> }[]>`select payload from workflow_checkpoints where run_id = ${input.runId} and step = ${input.step}`)[0]?.payload;
  }
  public async saveCheckpoint(input: SaveCheckpointInput): Promise<Readonly<Record<string, unknown>>> {
    return this.database.sql.begin(async (sql) => { await ownLease(sql, input); await storeCheckpoint(sql, input); await persistGeneratedArtifact(sql, input); await appendEvent(sql, input.runId, 'checkpoint_committed', { step: input.step, logicalGenerationId: input.logicalGenerationId ?? '' }); return input.checkpoint; });
  }

  public async commitStepAndEnqueueNext(input: CommitStepInput): Promise<WorkflowRun> {
    if (input.nextCommand.runId !== input.runId) throw new DomainConflictError('Outbox command run does not match workflow run');
    return this.database.sql.begin(async (sql) => {
      const current = await runById(sql, input.runId, true); if (current === undefined) throw new DomainNotFoundError('run'); if (current.version !== input.expectedVersion) throw new DomainConflictError('Run version is stale');
      await completeLease(sql, input); const nextStatus = transitionRun(current.status, input.event);
      const row = (await sql<RunRow[]>`update runs set status = ${nextStatus}, version = version + 1, updated_at = now() where id = ${input.runId} and version = ${input.expectedVersion} returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model`)[0];
      if (row === undefined) throw new DomainConflictError('Run version is stale');
      await storeCheckpoint(sql, { runId: input.runId, step: input.checkpointStep ?? input.event, invocationId: input.invocationId, checkpoint: input.checkpoint });
      if (input.artifact !== undefined) {
        const contentHash = input.artifact.contentHash ?? hashApprovalPayload(input.artifact.content);
        await sql`insert into specialist_artifacts (id, run_id, kind, logical_generation_id, generation_metadata, evidence_manifest_id, content, content_hash) values
          (${input.artifact.id}, ${input.runId}, ${input.artifact.kind}, ${input.artifact.logicalGenerationId ?? null}, ${jsonText(input.artifact.generationMetadata ?? {})}::jsonb,
          ${input.artifact.evidenceManifestId ?? null}, ${jsonText(input.artifact.content)}::jsonb, ${contentHash})`;
      }
      await appendEvent(sql, input.runId, input.event, { version: row.version, status: nextStatus }); await insertCommand(sql, input.nextCommand); return asRun(row);
    });
  }

  public async awaitApproval(input: AwaitApprovalInput): Promise<WorkflowRun> {
    if (hashApprovalPayload(input.subject.payload) !== input.subject.subjectHash) throw new DomainConflictError('Approval subject hash does not match its payload');
    return this.database.sql.begin(async (sql) => {
      const current = await runById(sql, input.runId, true); if (current === undefined) throw new DomainNotFoundError('run'); if (current.version !== input.expectedVersion) throw new DomainConflictError('Run version is stale');
      await completeLease(sql, input); const status = transitionRun(current.status, 'validation_requires_approval');
      const row = (await sql<RunRow[]>`update runs set status = ${status}, version = version + 1, updated_at = now() where id = ${input.runId} and version = ${input.expectedVersion} returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model, start_request_hash`)[0];
      if (row === undefined) throw new DomainConflictError('Run version is stale');
      await sql`insert into approval_subjects (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
        values (${input.subject.id}, ${input.runId}, ${row.version}, ${input.subject.subjectHash}, ${jsonText(input.subject.payload)}::jsonb, ${jsonText(input.subject.sectionIds)}::jsonb,
          ${jsonText(input.subject.recommendationIds)}::jsonb, ${jsonText(input.subject.citationIds)}::jsonb, ${jsonText(input.subject.policyTriggers)}::jsonb, ${input.subject.quorumVersion})`;
      for (const [ordinal, entry] of input.subject.entries.entries()) await sql`insert into approval_requirement_entries (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
        values (${entry.id}, ${input.subject.id}, ${entry.category}, ${jsonText(entry.eligibleAuthorities)}::jsonb, ${jsonText(entry.policyTriggers)}::jsonb, ${jsonText(entry.dependsOn)}::jsonb, ${ordinal})`;
      await sql`update approval_subjects set superseded_by_subject_id = ${input.subject.id}
        where run_id = ${input.runId} and id <> ${input.subject.id} and superseded_by_subject_id is null`;
      await appendEvent(sql, input.runId, 'awaiting_approval', { version: row.version, subjectHash: input.subject.subjectHash, quorumVersion: input.subject.quorumVersion }); return asRun(row);
    });
  }

  public async getApprovalSubject(input: Readonly<{ runId: WorkflowRun['id']; approvalSubjectId?: string | undefined }>): Promise<ApprovalSubject | undefined> {
    type SubjectRow = { id: string; run_id: string; draft_version: number; subject_hash: string; payload: Record<string, unknown>; section_ids: string[]; recommendation_ids: string[]; citation_ids: string[]; policy_triggers: string[]; quorum_version: string; superseded_by_subject_id: string | null };
    const subjects = input.approvalSubjectId === undefined
      ? await this.database.sql<SubjectRow[]>`select id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version, superseded_by_subject_id from approval_subjects where run_id = ${input.runId} and superseded_by_subject_id is null order by draft_version desc limit 1`
      : await this.database.sql<SubjectRow[]>`select id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version, superseded_by_subject_id from approval_subjects where run_id = ${input.runId} and id = ${input.approvalSubjectId}`;
    const subject = subjects[0]; if (subject === undefined) return undefined;
    const entries = await this.database.sql<{ id: string; category: ApprovalCategory; eligible_authorities: ApprovalAuthority[]; policy_triggers: string[]; depends_on: string[] }[]>`select id, category, eligible_authorities, policy_triggers, depends_on from approval_requirement_entries where approval_subject_id = ${subject.id} order by ordinal`;
    const decisions = await this.database.sql<{ action: ApprovalDecision['action']; entry_id: string; category: ApprovalCategory; authority: ApprovalAuthority; actor_id: string; original_payload: Record<string, unknown>; approved_payload: Record<string, unknown>; approved_subject_hash: string; edited_payload: Record<string, unknown> | null; diff: Record<string, unknown> | null; rationale: string | null; request_hash: string; created_at: Date | string }[]>`select action, entry_id, category, authority, actor_id, original_payload, approved_payload, approved_subject_hash, edited_payload, diff, rationale, request_hash, created_at from approval_decisions where approval_subject_id = ${subject.id} order by created_at, id`;
    return {
      id: subject.id, runId: subject.run_id as WorkflowRun['id'], draftVersion: subject.draft_version, subjectHash: subject.subject_hash, payload: dealBriefSchema.parse(subject.payload),
      sectionIds: subject.section_ids, recommendationIds: subject.recommendation_ids, citationIds: subject.citation_ids, policyTriggers: subject.policy_triggers,
      quorumVersion: subject.quorum_version,
      entries: entries.map((entry): ApprovalRequirementEntry => ({ id: entry.id, category: entry.category, eligibleAuthorities: entry.eligible_authorities, policyTriggers: entry.policy_triggers, dependsOn: entry.depends_on })),
      decisions: decisions.map((decision): ApprovalDecision => ({ action: decision.action, entryId: decision.entry_id, category: decision.category, authority: decision.authority,
        actorId: decision.actor_id as ApprovalDecision['actorId'], originalPayload: dealBriefSchema.parse(decision.original_payload), approvedPayload: dealBriefSchema.parse(decision.approved_payload),
        approvedSubjectHash: decision.approved_subject_hash, ...(decision.edited_payload === null ? {} : { editedPayload: dealBriefSchema.parse(decision.edited_payload) }),
        ...(decision.diff === null ? {} : { diff: decision.diff }), ...(decision.rationale === null ? {} : { rationale: decision.rationale }), requestHash: decision.request_hash, decidedAt: new Date(decision.created_at).toISOString() })),
      ...(subject.superseded_by_subject_id === null ? {} : { supersededBySubjectId: subject.superseded_by_subject_id })
    };
  }

  public async findDecisionByIdempotencyKey(input: Parameters<WorkflowStore['findDecisionByIdempotencyKey']>[0]) {
    return replayDecision(this.database.sql, input);
  }
  public async recordDecisionAndEnqueueFinalization(input: ApprovalDecisionInput): Promise<ApprovalDecisionStoreResult> {
    return this.database.sql.begin(async (sql) => {
      const prior = (await sql<{ request_hash: string }[]>`select request_hash from approval_decisions where idempotency_key = ${input.idempotencyKey} for update`)[0];
      if (prior !== undefined) {
        if (prior.request_hash !== input.requestHash) throw new DomainConflictError('Decision idempotency key conflicts with another decision');
        const replay = await replayDecision(sql, input);
        if (replay === undefined) throw new DomainConflictError('Persisted decision result is unavailable');
        return {
          run: replay.run, quorumSatisfied: replay.quorumSatisfied, rejected: replay.rejected,
          replayed: true, approvedSubjectHash: replay.approvedSubjectHash
        };
      }
      const current = await runById(sql, input.runId, true); if (current === undefined) throw new DomainNotFoundError('run'); if (current.status !== 'awaiting_approval' || current.version !== input.expectedVersion) throw new DomainConflictError('Run version is stale');
      const subject = (await sql<{ subject_hash: string }[]>`select subject_hash from approval_subjects where id = ${input.approvalSubjectId} and run_id = ${input.runId} for share`)[0];
      if (subject?.subject_hash !== input.expectedSubjectHash) throw new DomainConflictError('Approval subject is stale');
      const entry = (await sql<{ category: ApprovalCategory; eligible_authorities: ApprovalAuthority[]; depends_on: string[]; required: number }[]>`select category, eligible_authorities, depends_on,
        (select count(*)::int from approval_requirement_entries where approval_subject_id = ${input.approvalSubjectId}) required
        from approval_requirement_entries where approval_subject_id = ${input.approvalSubjectId} and id = ${input.entryId} for share`)[0];
      if (entry === undefined || entry.category !== input.category || !entry.eligible_authorities.includes(input.authority)) throw new DomainConflictError('Approval category or authority mismatch');
      const approved = await sql<{ entry_id: string; approved_subject_hash: string; actor_id: string; category: ApprovalCategory; authority: ApprovalAuthority }[]>`
        select entry_id, approved_subject_hash, actor_id, category, authority from approval_decisions
        where approval_subject_id = ${input.approvalSubjectId} and action <> 'reject' for update`;
      const approvedIds = new Set(approved.map(({ entry_id }) => entry_id)); if (entry.depends_on.some((dependency) => !approvedIds.has(dependency))) throw new DomainConflictError('Approval dependencies are incomplete');
      if (approved.some(({ approved_subject_hash }) => approved_subject_hash !== input.decision.approvedSubjectHash)) throw new DomainConflictError('Approval decisions do not bind the same effective snapshot');
      const oppositeCommercialAuthority = input.authority === 'deal_desk' ? 'sales_leader' : input.authority === 'sales_leader' ? 'deal_desk' : undefined;
      if (input.category === 'commercial_discount' && oppositeCommercialAuthority !== undefined
        && approved.some((prior) => prior.category === 'commercial_discount' && prior.authority === oppositeCommercialAuthority && prior.actor_id === input.actorId)) {
        throw new DomainConflictError('Distinct approval actors are required');
      }
      const rejected = input.decision.action === 'reject';
      const quorumSatisfied = !rejected && entry.required === approved.length + 1;
      const event = rejected ? 'approval_rejected' : quorumSatisfied ? 'approval_granted' : undefined;
      const status = event === undefined ? current.status : transitionRun(current.status, event);
      await sql`insert into approval_decisions (id, approval_subject_id, entry_id, action, actor_id, category, authority, idempotency_key, request_hash, rationale, original_payload, approved_payload, edited_payload, original_subject_hash, approved_subject_hash, diff, result_run_version, result_status, result_quorum_satisfied, result_rejected, created_at)
        values (${`decision_${crypto.randomUUID()}`}, ${input.approvalSubjectId}, ${input.entryId}, ${input.decision.action}, ${input.actorId}, ${input.category}, ${input.authority}, ${input.idempotencyKey}, ${input.requestHash},
          ${input.decision.rationale ?? null}, ${jsonText(input.decision.originalPayload)}::jsonb, ${jsonText(input.decision.approvedPayload)}::jsonb,
          ${input.decision.editedPayload === undefined ? null : jsonText(input.decision.editedPayload)}::jsonb, ${input.expectedSubjectHash}, ${input.decision.approvedSubjectHash},
          ${input.decision.diff === undefined ? null : jsonText(input.decision.diff)}::jsonb, ${current.version + 1}, ${status}, ${quorumSatisfied}, ${rejected}, ${input.decision.decidedAt}::timestamptz)`;
      const row = (await sql<RunRow[]>`update runs set status = ${status}, version = version + 1, updated_at = now() where id = ${input.runId} and version = ${input.expectedVersion} returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model`)[0];
      if (row === undefined) throw new DomainConflictError('Run version is stale');
      await appendEvent(sql, input.runId, event ?? 'approval_entry_recorded', { version: row.version, approvalSubjectId: input.approvalSubjectId, entryId: input.entryId, category: input.category, authority: input.authority, action: input.decision.action, approvedSubjectHash: input.decision.approvedSubjectHash });
      if (quorumSatisfied) await insertCommand(sql, input.finalizationCommand);
      return { run: asRun(row), quorumSatisfied, rejected, replayed: false, approvedSubjectHash: input.decision.approvedSubjectHash };
    });
  }

  public async replaceApprovalSubject(input: ReplaceApprovalSubjectInput): Promise<Readonly<{ run: WorkflowRun; subject: ApprovalSubject; replayed: boolean }>> {
    return this.database.sql.begin(async (sql) => {
      const prior = (await sql<{ request_hash: string }[]>`select request_hash from approval_decisions where idempotency_key = ${input.idempotencyKey} for update`)[0];
      if (prior !== undefined) {
        if (prior.request_hash !== input.requestHash) throw new DomainConflictError('Decision idempotency key conflicts with another decision');
        const replay = await replayDecision(sql, input);
        if (replay === undefined) throw new DomainConflictError('Persisted decision result is unavailable');
        const replaySubject = await this.getApprovalSubject({ runId: input.runId, approvalSubjectId: replay.approvalSubjectId });
        if (replaySubject === undefined) throw new DomainConflictError('Replacement approval subject is unavailable');
        return { run: replay.run, subject: replaySubject, replayed: true };
      }
      const current = await runById(sql, input.runId, true);
      if (current === undefined) throw new DomainNotFoundError('run');
      if (current.status !== 'awaiting_approval' || current.version !== input.expectedVersion) throw new DomainConflictError('Run version is stale');
      const old = (await sql<{ id: string }[]>`select id from approval_subjects where id = ${input.priorSubjectId} and run_id = ${input.runId} and superseded_by_subject_id is null for update`)[0];
      if (old === undefined) throw new DomainConflictError('Approval subject is stale');
      await sql`insert into approval_decisions (id, approval_subject_id, entry_id, action, actor_id, category, authority, idempotency_key, request_hash, rationale, original_payload, approved_payload, edited_payload, original_subject_hash, approved_subject_hash, diff, result_run_version, result_status, result_quorum_satisfied, result_rejected, created_at)
        values (${`decision_${crypto.randomUUID()}`}, ${input.priorSubjectId}, ${input.priorDecision.entryId}, ${input.priorDecision.action}, ${input.priorDecision.actorId}, ${input.priorDecision.category}, ${input.priorDecision.authority},
          ${input.idempotencyKey}, ${input.requestHash}, ${input.priorDecision.rationale ?? null}, ${jsonText(input.priorDecision.originalPayload)}::jsonb, ${jsonText(input.priorDecision.approvedPayload)}::jsonb,
          ${jsonText(input.priorDecision.editedPayload)}::jsonb, ${hashApprovalPayload(input.priorDecision.originalPayload)}, ${input.priorDecision.approvedSubjectHash}, ${jsonText(input.priorDecision.diff ?? {})}::jsonb,
          ${current.version + 1}, 'awaiting_approval', false, false, ${input.priorDecision.decidedAt}::timestamptz)`;
      await sql`insert into approval_subjects (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
        values (${input.subject.id}, ${input.runId}, ${current.version + 1}, ${input.subject.subjectHash}, ${jsonText(input.subject.payload)}::jsonb, ${jsonText(input.subject.sectionIds)}::jsonb,
          ${jsonText(input.subject.recommendationIds)}::jsonb, ${jsonText(input.subject.citationIds)}::jsonb, ${jsonText(input.subject.policyTriggers)}::jsonb, ${input.subject.quorumVersion})`;
      await sql`update approval_subjects set superseded_by_subject_id = ${input.subject.id} where id = ${input.priorSubjectId}`;
      for (const [ordinal, entry] of input.subject.entries.entries()) await sql`insert into approval_requirement_entries (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
        values (${entry.id}, ${input.subject.id}, ${entry.category}, ${jsonText(entry.eligibleAuthorities)}::jsonb, ${jsonText(entry.policyTriggers)}::jsonb, ${jsonText(entry.dependsOn)}::jsonb, ${ordinal})`;
      const row = (await sql<RunRow[]>`update runs set version = version + 1, updated_at = now() where id = ${input.runId} and version = ${input.expectedVersion}
        returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model, start_request_hash`)[0];
      if (row === undefined) throw new DomainConflictError('Run version is stale');
      await appendEvent(sql, input.runId, 'approval_subject_replaced', { priorSubjectId: input.priorSubjectId, approvalSubjectId: input.subject.id, subjectHash: input.subject.subjectHash });
      return { run: asRun(row), subject: { ...input.subject, draftVersion: row.version, decisions: [] }, replayed: false };
    });
  }

  public async findRegenerationByIdempotencyKey(input: Parameters<WorkflowStore['findRegenerationByIdempotencyKey']>[0]): Promise<WorkflowRun | undefined> {
    const event = (await this.database.sql<{ run_id: string; request_hash: string }[]>`select run_id, payload->>'requestHash' request_hash
      from run_events where type = 'regeneration_requested' and payload->>'idempotencyKey' = ${input.idempotencyKey}
      order by created_at limit 1`)[0];
    if (event === undefined) return undefined;
    if (event.request_hash !== input.requestHash) throw new DomainConflictError('Regeneration idempotency key conflicts with another command');
    const run = await runById(this.database.sql, event.run_id); if (run === undefined) throw new DomainNotFoundError('run');
    return asRun(run);
  }
  public async regenerateRun(input: RegenerateRunInput): Promise<WorkflowRun> {
    return this.database.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`regeneration:${input.idempotencyKey}`}))`;
      const replay = (await sql<{ run_id: string; request_hash: string }[]>`select run_id, payload->>'requestHash' request_hash
        from run_events where type = 'regeneration_requested' and payload->>'idempotencyKey' = ${input.idempotencyKey}
        order by created_at limit 1`)[0];
      if (replay !== undefined) {
        if (replay.request_hash !== input.requestHash) throw new DomainConflictError('Regeneration idempotency key conflicts with another command');
        const replayRun = await runById(sql, replay.run_id, true); if (replayRun === undefined) throw new DomainNotFoundError('run');
        return asRun(replayRun);
      }
      const current = await runById(sql, input.runId, true);
      if (current === undefined) throw new DomainNotFoundError('run');
      if (current.version !== input.expectedVersion || current.requested_by !== input.requestedBy || !['awaiting_approval', 'rejected'].includes(current.status)) throw new DomainConflictError('Run cannot be regenerated');
      const row = (await sql<RunRow[]>`update runs set status = 'synthesizing', version = version + 1, updated_at = now() where id = ${input.runId} and version = ${input.expectedVersion}
        returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model, start_request_hash`)[0];
      if (row === undefined) throw new DomainConflictError('Run version is stale');
      await insertCommand(sql, input.command);
      await appendEvent(sql, input.runId, 'regeneration_requested', {
        requestedBy: input.requestedBy, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, draftVersion: row.version
      });
      return asRun(row);
    });
  }

  public async finalizeRun(input: FinalizeRunInput): Promise<WorkflowRun> {
    if (hashApprovalPayload(input.payload) !== input.subjectHash) throw new DomainConflictError('Final brief hash does not match payload');
    return this.database.sql.begin(async (sql) => {
      const current = await runById(sql, input.runId, true); if (current === undefined) throw new DomainNotFoundError('run'); if (current.version !== input.expectedVersion) throw new DomainConflictError('Run version is stale');
      if (input.approvalSubjectId !== undefined) {
        const quorum = (await sql<{ required: number; approved: number; rejected: number; mismatched: number; distinct_commercial_actors: number; distinct_commercial_authorities: number }[]>`select
          (select count(*)::int from approval_requirement_entries where approval_subject_id = ${input.approvalSubjectId}) required,
          count(*) filter (where action <> 'reject')::int approved, count(*) filter (where action = 'reject')::int rejected,
          count(*) filter (where approved_subject_hash <> ${input.subjectHash})::int mismatched,
          count(distinct actor_id) filter (where action <> 'reject' and category = 'commercial_discount' and authority in ('deal_desk','sales_leader'))::int distinct_commercial_actors,
          count(distinct authority) filter (where action <> 'reject' and category = 'commercial_discount' and authority in ('deal_desk','sales_leader'))::int distinct_commercial_authorities
          from approval_decisions where approval_subject_id = ${input.approvalSubjectId}`)[0];
        if (quorum === undefined || quorum.required !== quorum.approved || quorum.rejected !== 0 || quorum.mismatched !== 0
          || (quorum.distinct_commercial_authorities === 2 && quorum.distinct_commercial_actors < 2)) throw new DomainConflictError('Approval quorum does not authorize this final snapshot');
      }
      await completeLease(sql, input);
      const draftVersion = input.approvalSubjectId === undefined ? 0 : (await sql<{ draft_version: number }[]>`select draft_version from approval_subjects where id = ${input.approvalSubjectId} and run_id = ${input.runId}`)[0]?.draft_version;
      if (draftVersion === undefined) throw new DomainConflictError('Approval subject is not bound to this run');
      const existing = (await sql<{ subject_hash: string; payload: Record<string, unknown> }[]>`select subject_hash, payload from briefs where run_id = ${input.runId} and draft_version = ${draftVersion} for update`)[0];
      if (existing !== undefined && (existing.subject_hash !== input.subjectHash || canonicalJson(existing.payload) !== canonicalJson(input.payload))) throw new DomainConflictError('Final brief replay conflicts with persisted snapshot');
      if (existing === undefined) await sql`insert into briefs (id, run_id, approval_subject_id, draft_version, payload, subject_hash, finalized_at) values
        (${`brief_${crypto.randomUUID()}`}, ${input.runId}, ${input.approvalSubjectId ?? null}, ${draftVersion}, ${jsonText(input.payload)}::jsonb, ${input.subjectHash}, now())`;
      const status = transitionRun(current.status, 'complete');
      const row = (await sql<RunRow[]>`update runs set status = ${status}, version = version + 1, updated_at = now() where id = ${input.runId} and version = ${input.expectedVersion} returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model`)[0];
      if (row === undefined) throw new DomainConflictError('Run version is stale'); await appendEvent(sql, input.runId, 'complete', { version: row.version, subjectHash: input.subjectHash, deterministic: true }); return asRun(row);
    });
  }

  public async failRun(input: Readonly<{ runId: WorkflowRun['id']; expectedVersion: number; invocationId: string; invocationOwner: string; leaseToken: string; causalCommandId: string; reason: string }>): Promise<WorkflowRun> {
    return this.database.sql.begin(async (sql) => {
      const current = await runById(sql, input.runId, true); if (current === undefined) throw new DomainNotFoundError('run'); if (current.status === 'failed') return asRun(current); if (current.version !== input.expectedVersion) throw new DomainConflictError('Run version is stale');
      await completeLease(sql, input); const status = transitionRun(current.status, 'fail');
      const row = (await sql<RunRow[]>`update runs set status = ${status}, version = version + 1, updated_at = now() where id = ${input.runId} and version = ${input.expectedVersion} returning id, opportunity_id, requested_by, status, version, generation_provider, generation_model`)[0];
      if (row === undefined) throw new DomainConflictError('Run version is stale'); await appendEvent(sql, input.runId, 'fail', { version: row.version, reason: input.reason }); return asRun(row);
    });
  }
}
