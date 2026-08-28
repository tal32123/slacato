import { sql } from 'drizzle-orm';
import {
  boolean, check, customType, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey,
  text, timestamp, unique, uniqueIndex
} from 'drizzle-orm/pg-core';

/**
 * Runtime query mapping only. The cumulative SQL migrations are canonical for
 * pgvector's tuple/dimension invariant and immutable-row triggers; do not use
 * Drizzle generation to replace or rewrite those historical migrations.
 */
/** Untyped pgvector column: a profile's dimension is stored and enforced in application invariants. */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => value.slice(1, -1).split(',').filter(Boolean).map(Number)
});
const tsvector = customType<{ data: string; driverData: string }>({ dataType: () => 'tsvector' });
const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const json = <T>(name: string) => jsonb(name).$type<T>().notNull();

export const personas = pgTable('personas', {
  id: text('id').primaryKey(), displayName: text('display_name').notNull(), role: text('role').notNull(), sourceCommit: text('source_commit'), createdAt: now()
}, (table) => [
  index('personas_source_commit_display_name_idx').on(table.sourceCommit, table.displayName, table.id),
  check('personas_source_commit_check', sql`${table.sourceCommit} is null or ${table.sourceCommit} ~ '^[0-9a-f]{40}$'`)
]);
export const permissionGrants = pgTable('permission_grants', {
  id: text('id').primaryKey(), personaId: text('persona_id').notNull().references(() => personas.id),
  accountId: text('account_id').references(() => accounts.id), sourceType: text('source_type'), canRead: boolean('can_read').notNull().default(false), canReadRestricted: boolean('can_read_restricted').notNull().default(false),
  canRequestApproval: boolean('can_request_approval').notNull().default(false), canApprove: boolean('can_approve').notNull().default(false), sensitivePricing: boolean('sensitive_pricing').notNull().default(false),
  sourceCommit: text('source_commit'), createdAt: now()
}, (table) => [
  index('permission_grants_source_commit_persona_idx').on(table.sourceCommit, table.personaId, table.accountId, table.sourceType, table.id),
  check('permission_grants_source_commit_check', sql`${table.sourceCommit} is null or ${table.sourceCommit} ~ '^[0-9a-f]{40}$'`)
]);
export const accounts = pgTable('accounts', { id: text('id').primaryKey(), name: text('name').notNull(), createdAt: now() });
export const opportunities = pgTable('opportunities', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id), name: text('name').notNull(), restricted: boolean('restricted').notNull().default(false), createdAt: now()
});
export const contacts = pgTable('contacts', { id: text('id').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id), name: text('name').notNull(), email: text('email'), createdAt: now() });
export const documentVersions = pgTable('document_versions', {
  id: text('id').primaryKey(), externalId: text('external_id').notNull(), version: integer('version').notNull(), sourceType: text('source_type').notNull(), contentHash: text('content_hash').notNull(), content: text('content').notNull(),
  eventDate: date('event_date'), reliabilityClass: text('reliability_class'), sourceLocator: text('source_locator'), classificationReason: text('classification_reason'), policyHash: text('policy_hash'), createdAt: now()
}, (table) => [
  uniqueIndex('document_versions_external_version_uq').on(table.externalId, table.version),
  check('document_versions_version_check', sql`${table.version} > 0`),
  check('document_versions_content_hash_check', sql`length(${table.contentHash}) > 0`),
  check('document_versions_provenance_ck', sql`(
    num_nonnulls(${table.reliabilityClass}, ${table.sourceLocator}, ${table.classificationReason}, ${table.policyHash}) = 0
    or (num_nulls(${table.reliabilityClass}, ${table.sourceLocator}, ${table.classificationReason}, ${table.policyHash}) = 0
      and length(${table.reliabilityClass}) > 0 and length(${table.sourceLocator}) > 0 and length(${table.classificationReason}) > 0 and ${table.policyHash} ~ '^[0-9a-f]{64}$')
  )`)
]);
export const evidenceVersions = pgTable('evidence_versions', {
  id: text('id').primaryKey(), documentVersionId: text('document_version_id').notNull().references(() => documentVersions.id), accountId: text('account_id').notNull().references(() => accounts.id), opportunityId: text('opportunity_id').references(() => opportunities.id),
  chunkIndex: integer('chunk_index').notNull(), sourceType: text('source_type').notNull(), sensitivity: text('sensitivity').notNull(), contentHash: text('content_hash').notNull(), content: text('content').notNull(),
  eventDate: date('event_date'), reliabilityClass: text('reliability_class'), sourceLocator: text('source_locator'), classificationReason: text('classification_reason'), policyHash: text('policy_hash'),
  embedding: vector('embedding'), embeddingProvider: text('embedding_provider'), embeddingModel: text('embedding_model'), embeddingDimension: integer('embedding_dimension'), embeddingProfile: text('embedding_profile'), embeddingVersion: text('embedding_version'), embeddingNormalization: text('embedding_normalization'), lexicalContent: tsvector('lexical_content').generatedAlwaysAs(sql`to_tsvector('english', coalesce(content, ''))`), createdAt: now()
}, (table) => [
  uniqueIndex('evidence_versions_document_chunk_uq').on(table.documentVersionId, table.chunkIndex),
  index('evidence_versions_fts_idx').using('gin', table.lexicalContent),
  index('evidence_versions_authorized_exact_idx').on(table.accountId, table.opportunityId, table.sourceType, table.sensitivity, table.embeddingProfile, table.embeddingDimension, table.id),
  index('evidence_versions_provenance_idx').on(table.accountId, table.opportunityId, table.sourceType, table.sensitivity, table.eventDate, table.id),
  check('evidence_versions_chunk_index_check', sql`${table.chunkIndex} >= 0`),
  check('evidence_versions_content_hash_check', sql`length(${table.contentHash}) > 0`),
  check('evidence_versions_provenance_ck', sql`(
    num_nonnulls(${table.reliabilityClass}, ${table.sourceLocator}, ${table.classificationReason}, ${table.policyHash}) = 0
    or (num_nulls(${table.reliabilityClass}, ${table.sourceLocator}, ${table.classificationReason}, ${table.policyHash}) = 0
      and length(${table.reliabilityClass}) > 0 and length(${table.sourceLocator}) > 0 and length(${table.classificationReason}) > 0 and ${table.policyHash} ~ '^[0-9a-f]{64}$')
  )`),
  check('evidence_versions_embedding_profile_ck', sql`(
    (${table.embedding} is null and ${table.embeddingProvider} is null and ${table.embeddingModel} is null and ${table.embeddingDimension} is null and ${table.embeddingProfile} is null and ${table.embeddingVersion} is null and ${table.embeddingNormalization} is null)
    or (${table.embedding} is not null and ${table.embeddingProvider} is not null and ${table.embeddingModel} is not null and ${table.embeddingDimension} > 0 and ${table.embeddingProfile} is not null and ${table.embeddingVersion} is not null and ${table.embeddingNormalization} is not null and vector_dims(${table.embedding}) = ${table.embeddingDimension})
  )`)
]);
export const runEvidenceManifests = pgTable('run_evidence_manifests', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), scopeHash: text('scope_hash').notNull(), policyHash: text('policy_hash').notNull(), indexProfile: text('index_profile').notNull(), createdAt: now() });
export const runEvidenceManifestEntries = pgTable('run_evidence_manifest_entries', { manifestId: text('manifest_id').notNull().references(() => runEvidenceManifests.id), evidenceVersionId: text('evidence_version_id').notNull().references(() => evidenceVersions.id), rank: integer('rank').notNull(), score: numeric('score').notNull(), contentHash: text('content_hash').notNull() }, (table) => [primaryKey({ columns: [table.manifestId, table.evidenceVersionId] })]);
export const runs = pgTable('runs', {
  id: text('id').primaryKey(), opportunityId: text('opportunity_id').notNull().references(() => opportunities.id), requestedBy: text('requested_by').notNull().references(() => personas.id), status: text('status').notNull(), generationProvider: text('generation_provider').notNull(), generationModel: text('generation_model').notNull(), version: integer('version').notNull().default(0), createdAt: now(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  check('runs_status_check', sql`${table.status} in ('created','retrieving','specialists_running','synthesizing','validating','awaiting_approval','finalizing','completed','rejected','failed')`),
  check('runs_version_check', sql`${table.version} >= 0`)
]);
export const runBudgets = pgTable('run_budgets', { runId: text('run_id').primaryKey().references(() => runs.id), maxCalls: integer('max_calls').notNull(), maxInputTokens: integer('max_input_tokens').notNull(), maxOutputTokens: integer('max_output_tokens').notNull(), deadlineMs: integer('deadline_ms'), usedCalls: integer('used_calls').notNull().default(0), usedInputTokens: integer('used_input_tokens').notNull().default(0), usedOutputTokens: integer('used_output_tokens').notNull().default(0), reservedOutputTokens: integer('reserved_output_tokens').notNull().default(0) }, (table) => [
  check('run_budgets_max_calls_check', sql`${table.maxCalls} > 0`), check('run_budgets_max_input_tokens_check', sql`${table.maxInputTokens} > 0`), check('run_budgets_max_output_tokens_check', sql`${table.maxOutputTokens} > 0`), check('run_budgets_deadline_ms_check', sql`${table.deadlineMs} > 0`),
  check('run_budgets_used_calls_check', sql`${table.usedCalls} >= 0`), check('run_budgets_used_input_tokens_check', sql`${table.usedInputTokens} >= 0`), check('run_budgets_used_output_tokens_check', sql`${table.usedOutputTokens} >= 0`), check('run_budgets_reserved_output_tokens_check', sql`${table.reservedOutputTokens} >= 0`),
  check('run_budgets_used_calls_max_check', sql`${table.usedCalls} <= ${table.maxCalls}`)
]);
export const runBudgetReservations = pgTable('run_budget_reservations', { id: text('id').primaryKey(), attemptId: text('attempt_id').references(() => generationAttempts.id), runId: text('run_id').notNull().references(() => runs.id), invocationId: text('invocation_id'), operation: text('operation').notNull(), ordinal: integer('ordinal').notNull(), reservedOutputTokens: integer('reserved_output_tokens').notNull(), grantedOutputTokens: integer('granted_output_tokens').notNull(), reservedInputTokens: integer('reserved_input_tokens').notNull().default(0), actualInputTokens: integer('actual_input_tokens'), actualOutputTokens: integer('actual_output_tokens'), requestId: text('request_id'), responseId: text('response_id'), failureCategory: text('failure_category'), failureCode: text('failure_code'), status: text('status').notNull(), createdAt: now(), settledAt: timestamp('settled_at', { withTimezone: true }) }, (table) => [
  uniqueIndex('run_budget_reservations_attempt_uq').on(table.attemptId).where(sql`${table.attemptId} is not null`), unique('run_budget_reservations_invocation_operation_ordinal_uq').on(table.runId, table.invocationId, table.operation, table.ordinal).nullsNotDistinct(),
  check('run_budget_reservations_reserved_output_tokens_check', sql`${table.reservedOutputTokens} > 0`), check('run_budget_reservations_grant_ck', sql`${table.grantedOutputTokens} > 0`), check('run_budget_reservations_status_check', sql`${table.status} in ('reserved','settled','released','possible_duplicate')`)
]);
export const outboxCommands = pgTable('outbox_commands', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), type: text('type').notNull(), payload: json<Record<string, unknown>>('payload'), idempotencyKey: text('idempotency_key').notNull(), status: text('status').notNull().default('pending'), deliveryAttempts: integer('delivery_attempts').notNull().default(0), availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(), claimedAt: timestamp('claimed_at', { withTimezone: true }), claimOwner: text('claim_owner'), claimToken: text('claim_token'), claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }), publishedAt: timestamp('published_at', { withTimezone: true }), consumedAt: timestamp('consumed_at', { withTimezone: true }), createdAt: now() }, (table) => [
  uniqueIndex('outbox_commands_idempotency_uq').on(table.idempotencyKey), index('outbox_commands_pending_idx').on(table.status, table.availableAt, table.id),
  check('outbox_commands_status_check', sql`${table.status} in ('pending','claimed','published','dead_letter_claimed','dead_letter')`), check('outbox_commands_delivery_attempts_check', sql`${table.deliveryAttempts} >= 0`)
]);
export const stepInvocations = pgTable('step_invocations', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), step: text('step').notNull(), owner: text('owner'), leaseToken: text('lease_token'), causalCommandId: text('causal_command_id').references(() => outboxCommands.id), leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }), heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }), attempt: integer('attempt').notNull().default(1), status: text('status').notNull().default('leased'), createdAt: now(), completedAt: timestamp('completed_at', { withTimezone: true }) }, (table) => [
  uniqueIndex('step_invocations_run_step_attempt_uq').on(table.runId, table.step, table.attempt), uniqueIndex('step_invocations_one_active_causal_command_uq').on(table.causalCommandId).where(sql`${table.status} = 'leased'`), index('step_invocations_live_idx').on(table.runId, table.step, table.status, table.leaseExpiresAt),
  check('step_invocations_attempt_check', sql`${table.attempt} > 0`), check('step_invocations_status_check', sql`${table.status} in ('leased','completed','abandoned')`), check('step_invocations_lease_ck', sql`(${table.status} = 'leased' and ${table.owner} is not null and ${table.leaseExpiresAt} is not null) or ${table.status} <> 'leased'`)
]);
export const workflowCheckpoints = pgTable('workflow_checkpoints', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), step: text('step').notNull(), payload: json<Record<string, unknown>>('payload'), createdAt: now() }, (table) => [uniqueIndex('workflow_checkpoints_run_step_uq').on(table.runId, table.step)]);
export const generationAttempts = pgTable('generation_attempts', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), invocationId: text('invocation_id').references(() => stepInvocations.id), operation: text('operation').notNull(), ordinal: integer('ordinal').notNull().default(1), status: text('status').notNull(), provider: text('provider').notNull(), model: text('model').notNull(), requestId: text('request_id'), responseId: text('response_id'), possibleDuplicate: boolean('possible_duplicate').notNull().default(false), inputTokens: integer('input_tokens'), outputTokens: integer('output_tokens'), startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp('completed_at', { withTimezone: true }) }, (table) => [
  check('generation_attempts_status_check', sql`${table.status} in ('attempt_started','completed','failed','possible_duplicate')`), check('generation_attempts_input_tokens_check', sql`${table.inputTokens} >= 0`), check('generation_attempts_output_tokens_check', sql`${table.outputTokens} >= 0`)
]);
export const contextCheckpoints = pgTable('context_checkpoints', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), payload: json<Record<string, unknown>>('payload'), scopeHash: text('scope_hash').notNull(), policyHash: text('policy_hash').notNull(), evidenceHash: text('evidence_hash').notNull(), createdAt: now() });
export const specialistArtifacts = pgTable('specialist_artifacts', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), kind: text('kind').notNull(), evidenceManifestId: text('evidence_manifest_id').references(() => runEvidenceManifests.id), content: json<Record<string, unknown>>('content'), contentHash: text('content_hash').notNull(), createdAt: now() }, (table) => [uniqueIndex('specialist_artifacts_run_kind_uq').on(table.runId, table.kind)]);
export const claims = pgTable('claims', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), artifactId: text('artifact_id').references(() => specialistArtifacts.id), statement: text('statement').notNull(), confidence: numeric('confidence').notNull(), createdAt: now() }, (table) => [check('claims_confidence_check', sql`${table.confidence} >= 0 and ${table.confidence} <= 1`)]);
export const citations = pgTable('citations', { id: text('id').primaryKey(), claimId: text('claim_id').notNull().references(() => claims.id), evidenceVersionId: text('evidence_version_id').notNull().references(() => evidenceVersions.id), locator: text('locator').notNull(), createdAt: now() }, (table) => [uniqueIndex('citations_claim_evidence_locator_uq').on(table.claimId, table.evidenceVersionId, table.locator)]);
export const approvalSubjects = pgTable('approval_subjects', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), draftVersion: integer('draft_version').notNull(), subjectHash: text('subject_hash').notNull(), payload: json<Record<string, unknown>>('payload'), policyTriggers: json<readonly string[]>('policy_triggers'), createdAt: now() }, (table) => [
  uniqueIndex('approval_subjects_run_version_uq').on(table.runId, table.draftVersion), uniqueIndex('approval_subjects_subject_hash_uq').on(table.subjectHash), unique('approval_subjects_id_run_hash_uq').on(table.id, table.runId, table.subjectHash),
  check('approval_subjects_draft_version_check', sql`${table.draftVersion} >= 0`), check('approval_subjects_subject_hash_check', sql`length(${table.subjectHash}) > 0`)
]);
export const approvalDecisions = pgTable('approval_decisions', { id: text('id').primaryKey(), approvalSubjectId: text('approval_subject_id').notNull().references(() => approvalSubjects.id), action: text('action').notNull(), actorId: text('actor_id').notNull().references(() => personas.id), rationale: text('rationale'), editedPayload: json<Record<string, unknown>>('edited_payload'), createdAt: now() }, (table) => [uniqueIndex('approval_decisions_subject_uq').on(table.approvalSubjectId)]);
export const briefs = pgTable('briefs', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), approvalSubjectId: text('approval_subject_id').references(() => approvalSubjects.id), payload: json<Record<string, unknown>>('payload'), subjectHash: text('subject_hash').notNull(), finalizedAt: timestamp('finalized_at', { withTimezone: true }), createdAt: now() }, (table) => [
  uniqueIndex('briefs_run_uq').on(table.runId), check('briefs_subject_hash_check', sql`length(${table.subjectHash}) > 0`),
  foreignKey({ columns: [table.approvalSubjectId, table.runId, table.subjectHash], foreignColumns: [approvalSubjects.id, approvalSubjects.runId, approvalSubjects.subjectHash], name: 'briefs_approval_subject_snapshot_fk' })
]);
export const traceSpans = pgTable('trace_spans', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), parentId: text('parent_id'), kind: text('kind').notNull(), status: text('status').notNull(), payload: json<Record<string, unknown>>('payload'), startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(), endedAt: timestamp('ended_at', { withTimezone: true }) });
export const runEvents = pgTable('run_events', { id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => runs.id), sequence: integer('sequence').notNull(), type: text('type').notNull(), payload: json<Record<string, unknown>>('payload'), createdAt: now() }, (table) => [uniqueIndex('run_events_run_sequence_uq').on(table.runId, table.sequence)]);
export const auditEvents = pgTable('audit_events', { id: text('id').primaryKey(), runId: text('run_id').references(() => runs.id), actorId: text('actor_id').references(() => personas.id), type: text('type').notNull(), payload: json<Record<string, unknown>>('payload'), createdAt: now() });
