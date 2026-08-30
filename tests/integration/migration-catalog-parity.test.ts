import { readFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { getTableConfig } from '../../packages/infrastructure/node_modules/drizzle-orm/pg-core/utils.js';
import { createDatabaseClient } from '@slacato/infrastructure/db/client';
import { PostgresProviderAttemptLedger } from '@slacato/infrastructure/db/repositories/provider-attempt-ledger';
import {
  approvalAuthorityGrants, approvalDecisions, approvalRequirementEntries, approvalSubjects, briefs, claims, documentVersions,
  evidenceVersions, generationAttempts, opportunityPolicyFacts, outboxCommands, runBudgetReservations, permissionGrants, runBudgets,
  runEvidenceManifestEntries, runEvidenceManifests, runEvents, runs, specialistArtifacts, stepInvocations, traceSpans, workflowCheckpoints
} from '@slacato/infrastructure/db/schema';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databasePrefix = 'catohw_catalog_';
const databaseNamePattern = /^catohw_catalog_[a-z0-9]{16}$/;
const migrationFiles = [
  '0000_initial',
  '0001_delivery_claim_leases',
  '0002_causal_command_consumption',
  '0003_approval_snapshot_linkage',
  '0004_persisted_run_budgets',
  '0005_active_causal_command',
  '0006_restricted_opportunity_grants',
  '0007_dead_letter_claim_recovery',
  '0008_provider_attempt_ledger',
  '0009_run_budget_deadline',
  '0010_evidence_provenance',
  '0011_persona_provenance',
  '0012_authorized_retrieval',
  '0013_manifest_replay',
  '0014_durable_brief_approvals',
  '0015_immutable_approval_replays',
  '0016_append_only_run_observability',
  '0017_canonical_grants_sessions',
  '0018_run_cancellation',
  '0019_remove_token_budgets',
  '0020_canonical_authorization_views'
].map((migration) => resolve(process.cwd(), 'drizzle', `${migration}.sql`));
const temporaryDatabases: string[] = [];
const execFile = promisify(execFileCallback);

function makeDatabaseName(): string {
  return `${databasePrefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function assertTemporaryDatabaseName(name: string): void {
  if (!databaseNamePattern.test(name)) throw new Error(`Refusing to use non-test database ${name}`);
}

function urlForDatabase(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(name: string): string {
  assertTemporaryDatabaseName(name);
  return `"${name}"`;
}

async function createTemporaryDatabase(name: string): Promise<void> {
  assertTemporaryDatabaseName(name);
  const maintenance = postgres(urlForDatabase('postgres'), { max: 1 });
  try {
    await maintenance.unsafe(`CREATE DATABASE ${quoteIdentifier(name)}`);
    temporaryDatabases.push(name);
  } finally {
    await maintenance.end({ timeout: 1 });
  }
}

async function dropTemporaryDatabase(name: string): Promise<void> {
  assertTemporaryDatabaseName(name);
  const maintenance = postgres(urlForDatabase('postgres'), { max: 1 });
  try {
    await maintenance`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`;
    await maintenance.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  } finally {
    await maintenance.end({ timeout: 1 });
  }
}

async function applyMigrations(database: Sql, files: readonly string[]): Promise<void> {
  for (const file of files) await database.unsafe(await readFile(file, 'utf8'));
}

async function catalog(database: Sql): Promise<Record<string, unknown>> {
  const [tables, columns, constraints, indexes, extensions] = await Promise.all([
    database<{ table_name: string }[]>`
      select relname as table_name from pg_class join pg_namespace on pg_namespace.oid = pg_class.relnamespace
      where nspname = 'public' and relkind = 'r' order by relname`,
    database<{ table_name: string; column_name: string; type: string; typmod: number; default: string | null; generated: string; identity: string; nullable: boolean }[]>`
      select relation.relname as table_name, attribute.attname as column_name,
        format_type(attribute.atttypid, attribute.atttypmod) as type, attribute.atttypmod as typmod,
        pg_get_expr(default_value.adbin, default_value.adrelid) as default, attribute.attgenerated as generated,
        attribute.attidentity as identity, not attribute.attnotnull as nullable
      from pg_attribute attribute join pg_class relation on relation.oid = attribute.attrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      left join pg_attrdef default_value on default_value.adrelid = attribute.attrelid and default_value.adnum = attribute.attnum
      where namespace.nspname = 'public' and relation.relkind = 'r' and attribute.attnum > 0 and not attribute.attisdropped
      order by relation.relname, attribute.attnum`,
    database<{ table_name: string; name: string; type: string; definition: string }[]>`
      select relation.relname as table_name, constraint_entry.conname as name, constraint_entry.contype as type,
        regexp_replace(pg_get_constraintdef(constraint_entry.oid, true), '\\s+', ' ', 'g') as definition
      from pg_constraint constraint_entry join pg_class relation on relation.oid = constraint_entry.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' order by relation.relname, constraint_entry.conname`,
    database<{ table_name: string; name: string; definition: string }[]>`
      select tablename as table_name, indexname as name, regexp_replace(indexdef, '\\s+', ' ', 'g') as definition
      from pg_indexes where schemaname = 'public' order by tablename, indexname`,
    database<{ name: string; version: string }[]>`
      select extname as name, extversion as version from pg_extension order by extname`
  ]);
  return { tables, columns, constraints, indexes, extensions };
}

afterEach(async () => {
  await Promise.all(temporaryDatabases.splice(0).map(dropTemporaryDatabase));
});

describe('durable migration catalog', () => {
  it('keeps the committed base immutable and gives clean installs the same catalog as upgrades', async () => {
    const originalBase = await readFile(resolve(process.cwd(), 'drizzle/0000_initial.sql'), 'utf8');
    const { stdout: committedBase } = await execFile('git', ['show', '5b89dce:drizzle/0000_initial.sql'], { cwd: process.cwd() });
    expect(originalBase).toBe(committedBase);
    const originalFollowUp = await readFile(resolve(process.cwd(), 'drizzle/0001_delivery_claim_leases.sql'), 'utf8');
    const { stdout: committedFollowUp } = await execFile('git', ['show', '5b89dce:drizzle/0001_delivery_claim_leases.sql'], { cwd: process.cwd() });
    expect(originalFollowUp).toBe(committedFollowUp);

    const cleanName = makeDatabaseName();
    const upgradeName = makeDatabaseName();
    const runnerName = makeDatabaseName();
    await Promise.all([
      createTemporaryDatabase(cleanName), createTemporaryDatabase(upgradeName), createTemporaryDatabase(runnerName)
    ]);
    const clean = postgres(urlForDatabase(cleanName), { max: 1 });
    const upgrade = postgres(urlForDatabase(upgradeName), { max: 1 });
    const runner = postgres(urlForDatabase(runnerName), { max: 1 });
    try {
      await applyMigrations(clean, migrationFiles);
      await applyMigrations(upgrade, migrationFiles.slice(0, 8));
      await execFile('pnpm', ['db:migrate'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: urlForDatabase(runnerName) }
      });
      await upgrade`insert into personas (id, display_name, role) values ('legacy-user', 'Legacy user', 'seller')`;
      await upgrade`insert into accounts (id, name) values ('legacy-account', 'Legacy account')`;
      await upgrade`insert into opportunities (id, account_id, name) values ('legacy-opportunity', 'legacy-account', 'Legacy opportunity')`;
      await upgrade`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, version) values ('legacy-run', 'legacy-opportunity', 'legacy-user', 'created', 'mock', 'mock-chat', 0)`;
      await upgrade`insert into document_versions (id, external_id, version, source_type, content_hash, content) values ('legacy-document', 'legacy-document', 1, 'salesforce', 'legacy-document-hash', 'legacy content')`;
      await upgrade`insert into evidence_versions (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content) values ('legacy-evidence', 'legacy-document', 'legacy-account', 'legacy-opportunity', 0, 'salesforce', 'standard', 'legacy-evidence-hash', 'legacy content')`;
      await upgrade`insert into run_evidence_manifests (id, run_id, scope_hash, policy_hash, index_profile) values ('legacy-manifest', 'legacy-run', 'legacy-scope', 'legacy-policy', 'legacy-profile')`;
      await upgrade`insert into run_evidence_manifest_entries (manifest_id, evidence_version_id, rank, score, content_hash) values ('legacy-manifest', 'legacy-evidence', 1, 1, 'legacy-evidence-hash')`;
      await upgrade`insert into run_budget_reservations (id, run_id, reserved_output_tokens, status) values ('legacy-reservation-a', 'legacy-run', 1, 'reserved'), ('legacy-reservation-b', 'legacy-run', 1, 'reserved')`;
      await applyMigrations(upgrade, migrationFiles.slice(8));
      expect(await upgrade<{ id: string; operation: string; ordinal: number }[]>`select id, operation, ordinal from run_budget_reservations where run_id = 'legacy-run' order by id`).toEqual([
        { id: 'legacy-reservation-a', operation: 'legacy:legacy-reservation-a', ordinal: 1 },
        { id: 'legacy-reservation-b', operation: 'legacy:legacy-reservation-b', ordinal: 1 }
      ]);
      const [cleanCatalog, upgradeCatalog, runnerCatalog] = await Promise.all([
        catalog(clean), catalog(upgrade), catalog(runner)
      ]);
      expect(cleanCatalog).toEqual(upgradeCatalog);
      expect(cleanCatalog).toEqual(runnerCatalog);
      const tokenBudgetColumns = (cleanCatalog.columns as readonly {
        table_name: string; column_name: string; nullable: boolean
      }[]).filter((column) =>
        column.table_name === 'run_budgets' &&
        (column.column_name === 'max_input_tokens' || column.column_name === 'max_output_tokens')
      );
      expect(tokenBudgetColumns.map(({ column_name, nullable }) => ({ column_name, nullable }))).toEqual([
        { column_name: 'max_input_tokens', nullable: true },
        { column_name: 'max_output_tokens', nullable: true }
      ]);
      const tokenBudgetConstraints = (cleanCatalog.constraints as readonly {
        table_name: string; definition: string
      }[]).filter((constraint) => constraint.table_name === 'run_budgets')
        .map((constraint) => constraint.definition)
        .join(' ');
      expect(tokenBudgetConstraints).not.toContain('max_input_tokens');
      expect(tokenBudgetConstraints).not.toContain('max_output_tokens');

      expect((cleanCatalog.columns as readonly {
        table_name: string; column_name: string; type: string; typmod: number; default: string | null;
        generated: string; identity: string; nullable: boolean
      }[]).filter((column) =>
        column.table_name === 'approval_decisions' && column.column_name.startsWith('result_')
      )).toEqual([
        {
          table_name: 'approval_decisions', column_name: 'result_run_version', type: 'integer', typmod: -1,
          default: null, generated: '', identity: '', nullable: false
        },
        {
          table_name: 'approval_decisions', column_name: 'result_status', type: 'text', typmod: -1,
          default: null, generated: '', identity: '', nullable: false
        },
        {
          table_name: 'approval_decisions', column_name: 'result_quorum_satisfied', type: 'boolean', typmod: -1,
          default: null, generated: '', identity: '', nullable: false
        },
        {
          table_name: 'approval_decisions', column_name: 'result_rejected', type: 'boolean', typmod: -1,
          default: null, generated: '', identity: '', nullable: false
        }
      ]);
      expect((cleanCatalog.constraints as readonly {
        table_name: string; name: string; type: string; definition: string
      }[])).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table_name: 'approval_decisions', name: 'approval_decisions_result_run_version_ck', type: 'c',
          definition: expect.stringContaining('result_run_version >= 0')
        }),
        expect.objectContaining({
          table_name: 'approval_decisions', name: 'approval_decisions_result_status_ck', type: 'c',
          definition: expect.stringContaining("'awaiting_approval'::text")
        }),
        expect.objectContaining({
          table_name: 'approval_decisions', name: 'approval_decisions_result_consistency_ck', type: 'c',
          definition: expect.stringContaining("result_rejected = (result_status = 'rejected'::text)")
        })
      ]));

      const serialized = JSON.stringify(cleanCatalog).toLowerCase();
      expect(serialized).toContain('"name":"vector"');
      expect(serialized).toContain('"column_name":"embedding","type":"vector","typmod":-1');
      expect(serialized).toContain('"column_name":"lexical_content"');
      expect(serialized).toContain('vector_dims(embedding) = embedding_dimension');
      expect(serialized).toContain('briefs_approval_subject_run_fk');
      expect(serialized).toContain('step_invocations_one_active_causal_command_uq');
      expect(serialized).toContain('run_budget_reservations_attempt_fk');
      expect(serialized).toContain('run_budget_reservations_generation_operation_ordinal_uq');
      expect(serialized).toContain('document_versions_provenance_ck');
      expect(serialized).toContain('evidence_versions_provenance_ck');
      expect(serialized).toContain('evidence_versions_provenance_idx');
      expect(serialized).toContain('permission_grants_source_commit_check');
      expect(serialized).toContain('permission_grants_source_commit_persona_idx');
      expect(serialized).toContain('run_evidence_manifests_query_hash_ck');
      expect(serialized).toContain('run_evidence_manifest_entries_citation_uq');
      expect(serialized).toContain('embedding_content_hash = content_hash');
      expect(serialized).toContain('run_evidence_manifests_context_limit_ck');
      expect(serialized).toContain('run_evidence_manifest_entries_included_characters_ck');
      expect(serialized).toContain('"column_name":"can_request_approval"');
      expect(serialized).toContain('"column_name":"event_date"');
      expect(serialized).toContain('"column_name":"reliability_class"');
      expect(serialized).toContain('"column_name":"source_locator"');
      expect(serialized).toContain('"column_name":"classification_reason"');
      expect(serialized).toContain('"column_name":"policy_hash"');
      expect((cleanCatalog.constraints as readonly { table_name: string; name: string; definition: string }[])).toEqual(expect.arrayContaining([
        expect.objectContaining({ table_name: 'run_budget_reservations', name: 'run_budget_reservations_generation_operation_ordinal_uq' })
      ]));
      expect(serialized).not.toContain('hnsw');
    } finally {
      await clean.end({ timeout: 1 });
      await upgrade.end({ timeout: 1 });
      await runner.end({ timeout: 1 });
    }
  });

  it('lets a restarted legacy run atomically adopt its previously unknown deadline', async () => {
    const name = makeDatabaseName();
    await createTemporaryDatabase(name);
    const url = urlForDatabase(name);
    const sql = postgres(url, { max: 1 });
    try {
      await applyMigrations(sql, migrationFiles.slice(0, 9));
      await sql`insert into personas (id, display_name, role) values ('legacy-deadline-user', 'Legacy deadline user', 'seller')`;
      await sql`insert into accounts (id, name) values ('legacy-deadline-account', 'Legacy deadline account')`;
      await sql`insert into opportunities (id, account_id, name) values ('legacy-deadline-opportunity', 'legacy-deadline-account', 'Legacy deadline opportunity')`;
      await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, version) values ('legacy-deadline-run', 'legacy-deadline-opportunity', 'legacy-deadline-user', 'created', 'mock', 'mock-chat', 0)`;
      await sql`insert into run_budgets (run_id, max_calls, max_input_tokens, max_output_tokens) values ('legacy-deadline-run', 2, 100, 20)`;
      await applyMigrations(sql, migrationFiles.slice(9));
      expect(await sql<{ deadline_ms: number | null }[]>`select deadline_ms from run_budgets where run_id = 'legacy-deadline-run'`).toEqual([{ deadline_ms: null }]);

      const firstDatabase = createDatabaseClient(url, 1);
      const secondDatabase = createDatabaseClient(url, 1);
      try {
        await expect(new PostgresProviderAttemptLedger(firstDatabase).assertRunBudget({
          scope: 'legacy-deadline-run', maxCalls: 3, deadlineMs: 3_000
        })).rejects.toThrow('does not match');
        expect(await sql<{ deadline_ms: number | null }[]>`select deadline_ms from run_budgets where run_id = 'legacy-deadline-run'`).toEqual([{ deadline_ms: null }]);

        const attempts = await Promise.allSettled([
          new PostgresProviderAttemptLedger(firstDatabase).assertRunBudget({ scope: 'legacy-deadline-run', maxCalls: 2, deadlineMs: 1_000 }),
          new PostgresProviderAttemptLedger(secondDatabase).assertRunBudget({ scope: 'legacy-deadline-run', maxCalls: 2, deadlineMs: 2_000 })
        ]);
        expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
        const [{ deadline_ms: adoptedDeadline }] = await sql<{ deadline_ms: number }[]>`select deadline_ms from run_budgets where run_id = 'legacy-deadline-run'`;
        expect([1_000, 2_000]).toContain(adoptedDeadline);
        await new PostgresProviderAttemptLedger(firstDatabase).assertRunBudget({ scope: 'legacy-deadline-run', maxCalls: 2, deadlineMs: adoptedDeadline });
      } finally {
        await Promise.all([firstDatabase.close(), secondDatabase.close()]);
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('exposes the final SQL columns and constraints through the runtime mapping', () => {
    expect(evidenceVersions.embedding.getSQLType()).toBe('vector');
    expect(evidenceVersions.lexicalContent.generated?.as).toBeDefined();
    expect(Object.keys(documentVersions)).toEqual(expect.arrayContaining([
      'eventDate', 'reliabilityClass', 'sourceLocator', 'classificationReason', 'policyHash'
    ]));
    expect(Object.keys(evidenceVersions)).toEqual(expect.arrayContaining([
      'eventDate', 'reliabilityClass', 'sourceLocator', 'classificationReason', 'policyHash', 'embeddingContentHash'
    ]));
    const documentProvenanceCheck = getTableConfig(documentVersions).checks.find((entry) => entry.name === 'document_versions_provenance_ck');
    expect(documentProvenanceCheck).toBeDefined();
    const evidenceConfig = getTableConfig(evidenceVersions);
    expect(evidenceConfig.checks.find((entry) => entry.name === 'evidence_versions_provenance_ck')).toBeDefined();
    expect(evidenceConfig.indexes.find((entry) => entry.config.name === 'evidence_versions_provenance_idx')?.config.columns
      .map((column) => 'name' in column ? column.name : undefined)).toEqual([
        'account_id', 'opportunity_id', 'source_type', 'sensitivity', 'event_date', 'id'
      ]);
    expect(Object.keys(permissionGrants)).toEqual(expect.arrayContaining([
      'personaId', 'accountId', 'canReadRestricted', 'canRequestApproval', 'canApprove', 'sourceCommit'
    ]));
    expect(Object.keys(runEvidenceManifests)).toEqual(expect.arrayContaining(['runId', 'queryHash', 'embeddingProvider', 'embeddingModel', 'embeddingDimension', 'contextLimit', 'diagnostics']));
    expect(Object.keys(runEvidenceManifestEntries)).toEqual(expect.arrayContaining(['manifestId', 'evidenceVersionId', 'citationId', 'sourceLocator', 'classificationReason', 'queryRank', 'fusionScore', 'includedCharacters']));
    expect(Object.keys(approvalSubjects)).toEqual(expect.arrayContaining(['policyTriggers', 'runId', 'subjectHash', 'sectionIds', 'recommendationIds', 'citationIds', 'quorumVersion']));
    expect(approvalSubjects.policyTriggers.getSQLType()).toBe('jsonb');
    expect(Object.keys(approvalRequirementEntries)).toEqual(expect.arrayContaining(['approvalSubjectId', 'category', 'eligibleAuthorities', 'dependsOn', 'ordinal']));
    expect(Object.keys(approvalDecisions)).toEqual(expect.arrayContaining([
      'entryId', 'category', 'authority', 'idempotencyKey', 'originalPayload', 'approvedPayload', 'approvedSubjectHash', 'diff',
      'resultRunVersion', 'resultStatus', 'resultQuorumSatisfied', 'resultRejected'
    ]));
    expect(Object.keys(approvalAuthorityGrants)).toEqual(expect.arrayContaining(['personaId', 'accountId', 'authority', 'demoOnly', 'source']));
    expect(Object.keys(opportunityPolicyFacts)).toEqual(expect.arrayContaining(['opportunityId', 'discountPercent', 'renewalUpliftPercent', 'liabilityCapChanged']));
    expect(Object.keys(briefs)).toEqual(expect.arrayContaining(['approvalSubjectId', 'runId', 'subjectHash', 'draftVersion']));
    expect(Object.keys(outboxCommands)).toEqual(expect.arrayContaining(['claimOwner', 'claimToken', 'claimExpiresAt', 'consumedAt']));
    const pendingIndex = getTableConfig(outboxCommands).indexes.find((entry) => entry.config.name === 'outbox_commands_pending_idx');
    expect(pendingIndex?.config.columns.map((column) => 'name' in column ? column.name : undefined)).toEqual(['status', 'available_at', 'id']);
    expect(Object.keys(stepInvocations)).toEqual(expect.arrayContaining(['causalCommandId', 'leaseToken']));
    expect(Object.keys(runs)).toEqual(expect.arrayContaining(['idempotencyKey', 'startRequestHash']));
    const runIndexes = getTableConfig(runs).indexes;
    expect(runIndexes.find((entry) => entry.config.name === 'runs_idempotency_key_uq')?.config.columns.map((column) => 'name' in column ? column.name : undefined)).toEqual(['idempotency_key']);
    expect(runIndexes.find((entry) => entry.config.name === 'runs_one_active_opportunity_uq')?.config.columns.map((column) => 'name' in column ? column.name : undefined)).toEqual(['opportunity_id']);
    expect(Object.keys(runBudgets)).toEqual(expect.arrayContaining(['reservedOutputTokens', 'deadlineMs', 'deadlineAt']));
    expect(runBudgets.maxInputTokens.notNull).toBe(false);
    expect(runBudgets.maxOutputTokens.notNull).toBe(false);
    const reservationConstraint = getTableConfig(runBudgetReservations).uniqueConstraints.find((entry) => entry.name === 'run_budget_reservations_generation_operation_ordinal_uq');
    expect(reservationConstraint?.columns.map((column) => column.name)).toEqual(['run_id', 'logical_generation_id', 'operation', 'ordinal']);
    expect(Object.keys(runBudgetReservations)).toEqual(expect.arrayContaining([
      'attemptId', 'invocationId', 'logicalGenerationId', 'operation', 'ordinal', 'grantedOutputTokens', 'reservedInputTokens',
      'actualInputTokens', 'actualOutputTokens', 'requestId', 'responseId', 'failureCategory', 'failureCode'
    ]));
    expect(Object.keys(generationAttempts)).toEqual(expect.arrayContaining(['logicalGenerationId', 'outputMode', 'validationAttempts', 'validationIssues', 'warnings']));
    expect(Object.keys(workflowCheckpoints)).toEqual(expect.arrayContaining(['invocationId', 'logicalGenerationId']));
    expect(Object.keys(specialistArtifacts)).toEqual(expect.arrayContaining(['draftVersion', 'outcome', 'warnings', 'logicalGenerationId', 'generationMetadata']));
    expect(Object.keys(traceSpans)).toEqual(expect.arrayContaining(['traceId', 'spanId', 'runId', 'parentId', 'step', 'attempt', 'kind', 'status', 'payload']));
    expect(Object.keys(runEvents)).toEqual(expect.arrayContaining(['runId', 'sequence', 'type', 'version', 'payload', 'createdAt']));
    expect(getTableConfig(traceSpans).indexes.map((entry) => entry.config.name)).toEqual(expect.arrayContaining([
      'trace_spans_run_span_uq', 'trace_spans_run_started_idx', 'trace_spans_trace_idx'
    ]));
    expect(getTableConfig(runEvents).indexes.map((entry) => entry.config.name)).toEqual(expect.arrayContaining([
      'run_events_run_sequence_uq', 'run_events_run_created_idx'
    ]));
    expect(claims.confidence.getSQLType()).toBe('numeric');
  });
});
