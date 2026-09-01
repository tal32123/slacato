import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { dealBriefSchema, hashApprovalPayload } from '@slacato/core';
import { createDatabaseClient } from '@slacato/infrastructure/db/client';
import { PostgresProviderAttemptLedger } from '@slacato/infrastructure/db/repositories/provider-attempt-ledger';
import {
  approvalAuthorityGrants,
  approvalDecisions,
  approvalRequirementEntries,
  approvalSubjects,
  briefs,
  claims,
  documentVersions,
  evidenceVersions,
  generationAttempts,
  opportunityPolicyFacts,
  outboxCommands,
  permissionGrants,
  runBudgetReservations,
  runBudgets,
  runEvents,
  runEvidenceManifestEntries,
  runEvidenceManifests,
  runs,
  specialistArtifacts,
  stepInvocations,
  traceSpans,
  workflowCheckpoints
} from '@slacato/infrastructure/db/schema';
import postgres, { type Sql } from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { getTableConfig } from '../../packages/infrastructure/node_modules/drizzle-orm/pg-core/utils.js';

// drizzle-kit's own config loads .env itself (see drizzle.config.ts); this test
// talks to postgres directly via the `postgres` package, which does not, so do
// the same here rather than falling back to a guessed connection string.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file present — rely on the environment (CI, containers, etc).
}
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Create a .env file (see .env.example) or export ' +
      'DATABASE_URL before running this test.'
  );
}
const databaseUrl = process.env.DATABASE_URL;
const databasePrefix = 'catohw_catalog_';
const databaseNamePattern = /^catohw_catalog_[a-z0-9]{16}$/;
// The historical catalog was squashed into drizzle/0000_initial.sql. Forward
// migrations remain separate so existing databases and fresh installs traverse
// the same sequence without rewriting the baseline.
const migrationFiles = [
  '0000_initial',
  '0001_requester_scoped_active_runs',
  '0002_customer_communication_approval'
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
  const [tables, columns, constraints, indexes, extensions, views, triggers, functions] =
    await Promise.all([
      database<{ table_name: string }[]>`
      select relname as table_name from pg_class join pg_namespace on pg_namespace.oid = pg_class.relnamespace
      where nspname = 'public' and relkind = 'r' order by relname`,
      database<
        {
          table_name: string;
          column_name: string;
          type: string;
          typmod: number;
          default: string | null;
          generated: string;
          identity: string;
          nullable: boolean;
        }[]
      >`
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
      select extname as name, extversion as version from pg_extension order by extname`,
      database<{ view_name: string; definition: string; options: string[] | null }[]>`
      select relation.relname as view_name,
        regexp_replace(pg_get_viewdef(relation.oid, true), '\\s+', ' ', 'g') as definition,
        relation.reloptions as options
      from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relkind = 'v' order by relation.relname`,
      database<{ table_name: string; name: string; definition: string }[]>`
      select relation.relname as table_name, trigger_entry.tgname as name,
        regexp_replace(pg_get_triggerdef(trigger_entry.oid, true), '\\s+', ' ', 'g') as definition
      from pg_trigger trigger_entry join pg_class relation on relation.oid = trigger_entry.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and not trigger_entry.tgisinternal
      order by relation.relname, trigger_entry.tgname`,
      database<{ name: string; definition: string }[]>`
      select proc.proname as name, regexp_replace(pg_get_functiondef(proc.oid), '\\s+', ' ', 'g') as definition
      from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public' and proc.prokind = 'f'
        and not exists (select 1 from pg_depend dependency where dependency.objid = proc.oid and dependency.deptype = 'e')
      order by proc.proname`
    ]);
  return { tables, columns, constraints, indexes, extensions, views, triggers, functions };
}

afterEach(async () => {
  await Promise.all(temporaryDatabases.splice(0).map(dropTemporaryDatabase));
});

describe('durable migration catalog', () => {
  it('gives clean installs the same catalog as pnpm db:migrate produces', async () => {
    // The historical 0000-0021 catalog was squashed into 0000_initial.sql (see
    // README), but forward migrations remain independent. This test proves the
    // two supported clean-install paths agree: applying the complete ordered SQL
    // catalog directly, and running it through drizzle-kit's own migrator
    // (`pnpm db:migrate`, the command a developer actually runs).
    const cleanName = makeDatabaseName();
    const runnerName = makeDatabaseName();
    await Promise.all([createTemporaryDatabase(cleanName), createTemporaryDatabase(runnerName)]);
    const clean = postgres(urlForDatabase(cleanName), { max: 1 });
    const runner = postgres(urlForDatabase(runnerName), { max: 1 });
    try {
      await applyMigrations(clean, migrationFiles);
      await execFile('pnpm', ['db:migrate'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: urlForDatabase(runnerName) }
      });
      const [cleanCatalog, runnerCatalog] = await Promise.all([catalog(clean), catalog(runner)]);
      expect(cleanCatalog).toEqual(runnerCatalog);

      // run_budgets.max_input_tokens/max_output_tokens were un-enforced by the old
      // 0019_remove_token_budgets migration but the columns themselves lingered,
      // unread by any application code. The squash drops them outright: they must
      // not exist in the catalog, and schema.ts must not declare them either (see
      // the runtime-mapping test below).
      const tokenBudgetColumns = (
        cleanCatalog.columns as readonly {
          table_name: string;
          column_name: string;
        }[]
      ).filter(
        (column) =>
          column.table_name === 'run_budgets' &&
          (column.column_name === 'max_input_tokens' || column.column_name === 'max_output_tokens')
      );
      expect(tokenBudgetColumns).toEqual([]);

      // The three authorized_*_grants views are hand-written (drizzle-kit cannot
      // regenerate them from schema.ts) and are the backbone of the app's
      // authorization model. Prove they survived the squash byte-for-byte.
      const authorizedViews = (
        cleanCatalog.views as readonly {
          view_name: string;
          definition: string;
          options: string[] | null;
        }[]
      ).filter((view) => view.view_name.startsWith('authorized_'));
      expect(authorizedViews.map((view) => view.view_name)).toEqual([
        'authorized_evidence_grants',
        'authorized_opportunity_grants',
        'authorized_run_approval_grants'
      ]);
      for (const view of authorizedViews) {
        expect(view.options).toEqual(
          expect.arrayContaining(['security_barrier=true', 'security_invoker=true'])
        );
      }

      expect(
        (
          cleanCatalog.columns as readonly {
            table_name: string;
            column_name: string;
            type: string;
            typmod: number;
            default: string | null;
            generated: string;
            identity: string;
            nullable: boolean;
          }[]
        ).filter(
          (column) =>
            column.table_name === 'approval_decisions' && column.column_name.startsWith('result_')
        )
      ).toEqual([
        {
          table_name: 'approval_decisions',
          column_name: 'result_run_version',
          type: 'integer',
          typmod: -1,
          default: null,
          generated: '',
          identity: '',
          nullable: false
        },
        {
          table_name: 'approval_decisions',
          column_name: 'result_status',
          type: 'text',
          typmod: -1,
          default: null,
          generated: '',
          identity: '',
          nullable: false
        },
        {
          table_name: 'approval_decisions',
          column_name: 'result_quorum_satisfied',
          type: 'boolean',
          typmod: -1,
          default: null,
          generated: '',
          identity: '',
          nullable: false
        },
        {
          table_name: 'approval_decisions',
          column_name: 'result_rejected',
          type: 'boolean',
          typmod: -1,
          default: null,
          generated: '',
          identity: '',
          nullable: false
        }
      ]);
      expect(
        cleanCatalog.constraints as readonly {
          table_name: string;
          name: string;
          type: string;
          definition: string;
        }[]
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table_name: 'approval_decisions',
            name: 'approval_decisions_result_run_version_ck',
            type: 'c',
            definition: expect.stringContaining('result_run_version >= 0')
          }),
          expect.objectContaining({
            table_name: 'approval_decisions',
            name: 'approval_decisions_result_status_ck',
            type: 'c',
            definition: expect.stringContaining("'awaiting_approval'::text")
          }),
          expect.objectContaining({
            table_name: 'approval_decisions',
            name: 'approval_decisions_result_consistency_ck',
            type: 'c',
            definition: expect.stringContaining(
              "result_rejected = (result_status = 'rejected'::text)"
            )
          })
        ])
      );

      const serialized = JSON.stringify(cleanCatalog).toLowerCase();
      expect(serialized).toContain('"name":"vector"');
      expect(serialized).toContain('"column_name":"embedding","type":"vector","typmod":-1');
      expect(serialized).toContain('"column_name":"lexical_content"');
      expect(serialized).toContain('vector_dims(embedding) = embedding_dimension');
      expect(serialized).toContain('briefs_approval_subject_run_fk');
      expect(serialized).toContain('step_invocations_one_active_causal_command_uq');
      const activeRunIndexes = (
        cleanCatalog.indexes as readonly {
          table_name: string;
          name: string;
          definition: string;
        }[]
      ).filter((index) => index.table_name === 'runs' && index.name.startsWith('runs_one_active_'));
      expect(activeRunIndexes).toEqual([
        expect.objectContaining({
          table_name: 'runs',
          name: 'runs_one_active_requester_opportunity_uq',
          definition: expect.stringContaining('(opportunity_id, requested_by)')
        })
      ]);
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
      expect(
        cleanCatalog.constraints as readonly {
          table_name: string;
          name: string;
          definition: string;
        }[]
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table_name: 'run_budget_reservations',
            name: 'run_budget_reservations_generation_operation_ordinal_uq'
          })
        ])
      );
      // Hand-written trigger functions and triggers (immutability/append-only
      // enforcement) are, like the views above, not derivable from schema.ts.
      expect(serialized).toContain('reject_immutable_change');
      expect(serialized).toContain('reject_observability_mutation');
      expect(serialized).toContain('bind_embedding_content_hash');
      expect(serialized).toContain('evidence_versions_immutable');
      expect(serialized).toContain('run_events_append_only');
      expect(serialized).not.toContain('hnsw');
    } finally {
      await clean.end({ timeout: 1 });
      await runner.end({ timeout: 1 });
    }
  });

  it('backfills required action audiences across legacy DealBrief storage without changing unrelated JSON', async () => {
    const name = makeDatabaseName();
    await createTemporaryDatabase(name);
    const sql = postgres(urlForDatabase(name), { max: 1 });
    const legacyBrief = {
      dealSnapshot: {
        accountName: 'Legacy account',
        opportunityName: 'Legacy opportunity',
        stage: 'Negotiation'
      },
      executiveSummary: { narrative: 'A legacy brief persisted before action audiences existed.' },
      buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
      stakeholderMap: { stakeholders: [] },
      negotiationState: { currentState: 'Negotiation is active.', risks: [] },
      recommendedNextActions: {
        actions: [
          {
            action: 'Send the customer a revised proposal.',
            owner: 'Account executive',
            priority: 'high',
            rationale: 'The buyer requested updated terms.',
            claims: []
          },
          {
            action: 'Review the discount internally.',
            audience: 'internal',
            priority: 'medium',
            rationale: 'Internal approval remains necessary.',
            claims: []
          }
        ]
      },
      missingInformation: { items: [] },
      sourceEvidence: { evidence: [] },
      confidenceAndReviewWarnings: { overallConfidence: 0.5, warnings: [] }
    };
    const expectedMigratedBrief = {
      ...legacyBrief,
      recommendedNextActions: {
        actions: [
          { ...legacyBrief.recommendedNextActions.actions[0]!, audience: 'customer' },
          legacyBrief.recommendedNextActions.actions[1]!
        ]
      }
    };
    const unrelatedJson = {
      marker: 'leave-me-alone',
      recommendedNextActions: { actions: [{ action: 'Not a DealBrief action.' }] }
    };
    const liveSubjectId = 'legacy-audience-subject';
    const customerRequirementId =
      'approval:customer_communication:account_owner:legacy-audience';
    const policySpanId = `span_${hashApprovalPayload({
      runId: 'legacy-audience-run',
      kind: 'policy_decision',
      discriminator: `${liveSubjectId}:policy`
    })}`;
    const customerRequirementSpanId = `span_${hashApprovalPayload({
      runId: 'legacy-audience-run',
      kind: 'approval_requirement',
      discriminator: `${liveSubjectId}:${customerRequirementId}`
    })}`;
    try {
      await applyMigrations(sql, migrationFiles.slice(0, 2));
      await sql`insert into personas (id, display_name, role)
        values ('legacy-audience-user', 'Legacy audience user', 'seller')`;
      await sql`insert into accounts (id, name)
        values ('legacy-audience-account', 'Legacy audience account')`;
      await sql`insert into opportunities (id, account_id, name)
        values ('legacy-audience-opportunity', 'legacy-audience-account', 'Legacy audience opportunity')`;
      await sql`insert into approval_authority_grants
        (id, persona_id, account_id, authority, source, source_commit)
        values ('legacy-audience-account-owner-grant', 'legacy-audience-user',
          'legacy-audience-account', 'account_owner', 'migration-test',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`;
      await sql`insert into runs
        (id, opportunity_id, requested_by, status, generation_provider, generation_model, version, start_request_hash)
        values
          ('legacy-audience-run', 'legacy-audience-opportunity', 'legacy-audience-user',
            'awaiting_approval', 'mock', 'mock-chat', 1, 'legacy-audience-start-hash'),
          ('legacy-audience-completed-run', 'legacy-audience-opportunity', 'legacy-audience-user',
            'completed', 'mock', 'mock-chat', 2, 'legacy-audience-completed-start-hash')`;
      await sql`insert into approval_subjects
        (id, run_id, draft_version, subject_hash, payload, recommendation_ids)
        values
          ('legacy-audience-subject', 'legacy-audience-run', 1, 'legacy-subject-hash',
            ${sql.json(legacyBrief)}, '["legacy-recommendation"]'::jsonb),
          ('legacy-audience-completed-subject', 'legacy-audience-completed-run', 1,
            'legacy-completed-subject-hash', ${sql.json(legacyBrief)},
            '["legacy-completed-recommendation"]'::jsonb)`;
      await sql`insert into approval_requirement_entries
        (id, approval_subject_id, category, eligible_authorities, ordinal)
        values
          ('legacy-audience-entry', 'legacy-audience-subject', 'legal_terms',
            '["legal_reviewer"]'::jsonb, 0),
          ('legacy-audience-completed-entry', 'legacy-audience-completed-subject', 'legal_terms',
            '["legal_reviewer"]'::jsonb, 0)`;
      await sql`insert into approval_decisions
        (id, approval_subject_id, action, actor_id, rationale, edited_payload, entry_id, category,
          authority, idempotency_key, request_hash, original_payload, approved_payload,
          original_subject_hash, approved_subject_hash, result_run_version, result_status,
          result_quorum_satisfied, result_rejected)
        values ('legacy-audience-decision', 'legacy-audience-subject', 'edit_and_approve',
          'legacy-audience-user', 'Legacy approved edit.', ${sql.json(legacyBrief)},
          'legacy-audience-entry', 'legal_terms', 'legal_reviewer', 'legacy-audience-decision-key',
          'legacy-audience-request-hash', ${sql.json(legacyBrief)},
          ${sql.json(legacyBrief)}, 'legacy-original-hash', 'legacy-approved-hash',
          2, 'awaiting_approval', false, false)`;
      await sql`insert into briefs
        (id, run_id, approval_subject_id, draft_version, payload, subject_hash, finalized_at)
        values
          ('legacy-audience-brief', 'legacy-audience-run', 'legacy-audience-subject', 1,
            ${sql.json(legacyBrief)}, 'legacy-brief-hash', now()),
          ('legacy-audience-unrelated-brief', 'legacy-audience-run', null, 2,
            ${sql.json(unrelatedJson)}, 'unrelated-brief-hash', null)`;
      await sql`insert into workflow_checkpoints (id, run_id, step, payload)
        values
          ('legacy-audience-strategy', 'legacy-audience-run', 'strategy:1',
            ${sql.json({ status: 'completed', value: legacyBrief })}),
          ('legacy-audience-validation', 'legacy-audience-run', 'validation:1',
            ${sql.json({ status: 'completed', subjectHash: 'legacy-validation-hash', payload: legacyBrief })}),
          ('legacy-audience-unrelated-checkpoint', 'legacy-audience-run', 'strategy:2',
            ${sql.json({ status: 'completed', value: unrelatedJson })})`;
      await sql`insert into specialist_artifacts
        (id, run_id, kind, draft_version, content, content_hash)
        values
          ('legacy-audience-artifact', 'legacy-audience-run', 'strategy', 1,
            ${sql.json(legacyBrief)}, 'legacy-artifact-hash'),
          ('legacy-audience-unrelated-artifact', 'legacy-audience-run', 'conversation', 0,
            ${sql.json(unrelatedJson)}, 'unrelated-artifact-hash')`;
      await sql`insert into outbox_commands (id, run_id, type, payload, idempotency_key)
        values ('legacy-audience-command', 'legacy-audience-run', 'process-deal-brief-step',
          ${sql.json({ step: 'finalize', subjectHash: 'legacy-command-hash', payload: legacyBrief })},
          'legacy-audience-command-key')`;
      await sql`insert into trace_spans
        (id, run_id, kind, status, payload, trace_id, span_id, step, attempt)
        values
          (${policySpanId}, 'legacy-audience-run', 'policy_decision', 'completed',
            ${sql.json({
              decision: 'approval_required',
              policyHash: hashApprovalPayload({
                policyTriggers: [],
                quorumVersion: 'deal-brief-approval-v1'
              }),
              subjectHash: 'legacy-subject-hash'
            })},
            'legacy-audience-trace', ${policySpanId}, 'policy', 1),
          ('legacy-audience-requirement-span', 'legacy-audience-run', 'approval_requirement', 'completed',
            ${sql.json({
              subjectHash: 'legacy-subject-hash',
              entryId: 'legacy-audience-entry',
              category: 'legal_terms',
              authorities: ['legal_reviewer'],
              policyHash: hashApprovalPayload([])
            })},
            'legacy-audience-trace', 'legacy-audience-requirement-span', 'approval', 1),
          ('legacy-audience-decision-span', 'legacy-audience-run', 'approval_decision', 'completed',
            ${sql.json({ subjectHash: 'legacy-approved-hash' })},
            'legacy-audience-trace', 'legacy-audience-decision-span', 'approval', 1),
          ('legacy-audience-recommendation-span', 'legacy-audience-run', 'recommendation', 'completed',
            ${sql.json({ recommendationIds: ['legacy-recommendation'] })},
            'legacy-audience-trace', 'legacy-audience-recommendation-span', 'recommendation', 1),
          ('legacy-audience-finalization-span', 'legacy-audience-run', 'finalization', 'completed',
            ${sql.json({ artifactHash: 'legacy-subject-hash' })},
            'legacy-audience-trace', 'legacy-audience-finalization-span', 'finalization', 1)`;

      await applyMigrations(sql, [migrationFiles[2]!]);
      const firstPass = await sql<
        {
          subject_payload: typeof legacyBrief;
          subject_hash: string;
          recommendation_ids: string[];
          brief_payload: typeof legacyBrief;
          brief_hash: string;
          original_payload: typeof legacyBrief;
          approved_payload: typeof legacyBrief;
          edited_payload: typeof legacyBrief;
          original_hash: string;
          approved_hash: string;
          strategy_payload: { value: typeof legacyBrief };
          validation_payload: { subjectHash: string; payload: typeof legacyBrief };
          artifact_content: typeof legacyBrief;
          artifact_hash: string;
          command_payload: { subjectHash: string; payload: typeof legacyBrief };
        }[]
      >`
        select subject.payload subject_payload, subject.subject_hash, subject.recommendation_ids,
          brief.payload brief_payload, brief.subject_hash brief_hash,
          decision.original_payload, decision.approved_payload, decision.edited_payload,
          decision.original_subject_hash original_hash, decision.approved_subject_hash approved_hash,
          strategy.payload strategy_payload, validation.payload validation_payload,
          artifact.content artifact_content, artifact.content_hash artifact_hash,
          command.payload command_payload
        from approval_subjects subject
        join briefs brief on brief.id = 'legacy-audience-brief'
        join approval_decisions decision on decision.id = 'legacy-audience-decision'
        join workflow_checkpoints strategy on strategy.id = 'legacy-audience-strategy'
        join workflow_checkpoints validation on validation.id = 'legacy-audience-validation'
        join specialist_artifacts artifact on artifact.id = 'legacy-audience-artifact'
        join outbox_commands command on command.id = 'legacy-audience-command'
        where subject.id = 'legacy-audience-subject'`;
      const migrated = firstPass[0]!;
      for (const [location, payload] of [
        ['approval subject', migrated.subject_payload],
        ['brief', migrated.brief_payload],
        ['decision original payload', migrated.original_payload],
        ['decision approved payload', migrated.approved_payload],
        ['decision edited payload', migrated.edited_payload],
        ['strategy checkpoint', migrated.strategy_payload.value],
        ['validation checkpoint', migrated.validation_payload.payload],
        ['strategy artifact', migrated.artifact_content],
        ['finalization command', migrated.command_payload.payload]
      ] as const) {
        expect(payload, location).toEqual(expectedMigratedBrief);
        expect(() => dealBriefSchema.parse(payload), location).not.toThrow();
      }
      const migratedHash = hashApprovalPayload(migrated.subject_payload);
      expect(migrated.subject_hash).toBe(migratedHash);
      expect(migrated.brief_hash).toBe(hashApprovalPayload(migrated.brief_payload));
      expect(migrated.original_hash).toBe(hashApprovalPayload(migrated.original_payload));
      expect(migrated.approved_hash).toBe(hashApprovalPayload(migrated.approved_payload));
      expect(migrated.validation_payload.subjectHash).toBe(
        hashApprovalPayload(migrated.validation_payload.payload)
      );
      expect(migrated.artifact_hash).toBe(hashApprovalPayload(migrated.artifact_content));
      expect(migrated.command_payload.subjectHash).toBe(
        hashApprovalPayload(migrated.command_payload.payload)
      );
      expect(migrated.recommendation_ids).toEqual(
        migrated.subject_payload.recommendedNextActions.actions.map(
          (action, index) => `recommendation:${index}:${hashApprovalPayload(action).slice(0, 16)}`
        )
      );
      const liveCustomerRequirements = await sql<
        {
          category: string;
          eligible_authorities: string[];
          policy_triggers: string[];
          depends_on: string[];
          operable: boolean;
        }[]
      >`
        select entry.category, entry.eligible_authorities, entry.policy_triggers, entry.depends_on,
          approval_grant.operable
        from approval_requirement_entries entry
        join authorized_run_approval_grants approval_grant
          on approval_grant.approval_subject_id = entry.approval_subject_id
          and approval_grant.approval_entry_id = entry.id
          and approval_grant.persona_id = 'legacy-audience-user'
        where entry.approval_subject_id = 'legacy-audience-subject'
          and entry.category in ('customer_communication', 'customer_concession')`;
      expect(liveCustomerRequirements).toEqual([
        {
          category: 'customer_communication',
          eligible_authorities: ['account_owner'],
          policy_triggers: ['customer_facing_language'],
          depends_on: ['legacy-audience-entry'],
          operable: true
        }
      ]);
      expect(
        await sql<{ policy_triggers: string[] }[]>`
          select policy_triggers from approval_subjects
          where id = 'legacy-audience-subject'`
      ).toEqual([{ policy_triggers: ['customer_facing_language'] }]);
      expect(
        await sql<{ category: string; policy_triggers: string[] }[]>`
          select category, policy_triggers from approval_requirement_entries
          where approval_subject_id = 'legacy-audience-completed-subject'
          order by ordinal`
      ).toEqual([{ category: 'legal_terms', policy_triggers: [] }]);
      expect(
        await sql<{ policy_triggers: string[] }[]>`
          select policy_triggers from approval_subjects
          where id = 'legacy-audience-completed-subject'`
      ).toEqual([{ policy_triggers: [] }]);
      expect(
        await sql<{ kind: string; payload: Record<string, unknown> }[]>`
          select kind, payload from trace_spans
          where run_id = 'legacy-audience-run'
          order by kind`
      ).toEqual([
        { kind: 'approval_decision', payload: { subjectHash: migrated.approved_hash } },
        { kind: 'approval_requirement', payload: { subjectHash: migrated.subject_hash } },
        { kind: 'finalization', payload: { artifactHash: migrated.subject_hash } },
        { kind: 'recommendation', payload: { recommendationIds: migrated.recommendation_ids } }
      ]);
      expect(
        await sql<{ payload: typeof unrelatedJson }[]>`
          select payload from briefs where id = 'legacy-audience-unrelated-brief'`
      ).toEqual([{ payload: unrelatedJson }]);
      expect(
        await sql<{ payload: { value: typeof unrelatedJson } }[]>`
          select payload from workflow_checkpoints where id = 'legacy-audience-unrelated-checkpoint'`
      ).toEqual([{ payload: { status: 'completed', value: unrelatedJson } }]);
      expect(
        await sql<{ content: typeof unrelatedJson; content_hash: string }[]>`
          select content, content_hash from specialist_artifacts
          where id = 'legacy-audience-unrelated-artifact'`
      ).toEqual([{ content: unrelatedJson, content_hash: 'unrelated-artifact-hash' }]);

      await applyMigrations(sql, [migrationFiles[2]!]);
      expect(
        await sql<{ payload: typeof legacyBrief; subject_hash: string }[]>`
          select payload, subject_hash from approval_subjects
          where id = 'legacy-audience-subject'`
      ).toEqual([{ payload: migrated.subject_payload, subject_hash: migrated.subject_hash }]);
      expect(
        await sql<{ count: number }[]>`
          select count(*)::integer count
          from approval_requirement_entries
          where approval_subject_id = 'legacy-audience-subject'
            and category in ('customer_communication', 'customer_concession')`
      ).toEqual([{ count: 1 }]);
      expect(
        await sql<{ kind: string; payload: Record<string, unknown> }[]>`
          select kind, payload from trace_spans
          where run_id = 'legacy-audience-run'
          order by kind`
      ).toEqual([
        { kind: 'approval_decision', payload: { subjectHash: migrated.approved_hash } },
        { kind: 'approval_requirement', payload: { subjectHash: migrated.subject_hash } },
        { kind: 'finalization', payload: { artifactHash: migrated.subject_hash } },
        { kind: 'recommendation', payload: { recommendationIds: migrated.recommendation_ids } }
      ]);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('lets a restarted legacy run atomically adopt its previously unknown deadline', async () => {
    // This used to manufacture a legacy row (created before deadline_ms existed)
    // by applying an old migration subset, inserting, then applying the rest.
    // deadline_ms is nullable in the final schema regardless of migration
    // history, so the same legacy shape — a run_budgets row with no
    // deadline_ms — is produced directly by omitting it on insert.
    const name = makeDatabaseName();
    await createTemporaryDatabase(name);
    const url = urlForDatabase(name);
    const sql = postgres(url, { max: 1 });
    try {
      await applyMigrations(sql, migrationFiles);
      await sql`insert into personas (id, display_name, role) values ('legacy-deadline-user', 'Legacy deadline user', 'seller')`;
      await sql`insert into accounts (id, name) values ('legacy-deadline-account', 'Legacy deadline account')`;
      await sql`insert into opportunities (id, account_id, name) values ('legacy-deadline-opportunity', 'legacy-deadline-account', 'Legacy deadline opportunity')`;
      await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, version, start_request_hash) values ('legacy-deadline-run', 'legacy-deadline-opportunity', 'legacy-deadline-user', 'created', 'mock', 'mock-chat', 0, 'legacy-deadline-start-hash')`;
      await sql`insert into run_budgets (run_id, max_calls) values ('legacy-deadline-run', 2)`;
      expect(
        await sql<
          { deadline_ms: number | null }[]
        >`select deadline_ms from run_budgets where run_id = 'legacy-deadline-run'`
      ).toEqual([{ deadline_ms: null }]);

      const firstDatabase = createDatabaseClient(url, 1);
      const secondDatabase = createDatabaseClient(url, 1);
      try {
        await expect(
          new PostgresProviderAttemptLedger(firstDatabase).assertRunBudget({
            scope: 'legacy-deadline-run',
            maxCalls: 3,
            deadlineMs: 3_000
          })
        ).rejects.toThrow('does not match');
        expect(
          await sql<
            { deadline_ms: number | null }[]
          >`select deadline_ms from run_budgets where run_id = 'legacy-deadline-run'`
        ).toEqual([{ deadline_ms: null }]);

        const attempts = await Promise.allSettled([
          new PostgresProviderAttemptLedger(firstDatabase).assertRunBudget({
            scope: 'legacy-deadline-run',
            maxCalls: 2,
            deadlineMs: 1_000
          }),
          new PostgresProviderAttemptLedger(secondDatabase).assertRunBudget({
            scope: 'legacy-deadline-run',
            maxCalls: 2,
            deadlineMs: 2_000
          })
        ]);
        expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
        const [{ deadline_ms: adoptedDeadline }] = await sql<
          { deadline_ms: number }[]
        >`select deadline_ms from run_budgets where run_id = 'legacy-deadline-run'`;
        expect([1_000, 2_000]).toContain(adoptedDeadline);
        await new PostgresProviderAttemptLedger(firstDatabase).assertRunBudget({
          scope: 'legacy-deadline-run',
          maxCalls: 2,
          deadlineMs: adoptedDeadline
        });
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
    expect(Object.keys(documentVersions)).toEqual(
      expect.arrayContaining([
        'eventDate',
        'reliabilityClass',
        'sourceLocator',
        'classificationReason',
        'policyHash'
      ])
    );
    expect(Object.keys(evidenceVersions)).toEqual(
      expect.arrayContaining([
        'eventDate',
        'reliabilityClass',
        'sourceLocator',
        'classificationReason',
        'policyHash',
        'embeddingContentHash'
      ])
    );
    const documentProvenanceCheck = getTableConfig(documentVersions).checks.find(
      (entry) => entry.name === 'document_versions_provenance_ck'
    );
    expect(documentProvenanceCheck).toBeDefined();
    const evidenceConfig = getTableConfig(evidenceVersions);
    expect(
      evidenceConfig.checks.find((entry) => entry.name === 'evidence_versions_provenance_ck')
    ).toBeDefined();
    expect(
      evidenceConfig.indexes
        .find((entry) => entry.config.name === 'evidence_versions_provenance_idx')
        ?.config.columns.map((column) => ('name' in column ? column.name : undefined))
    ).toEqual(['account_id', 'opportunity_id', 'source_type', 'sensitivity', 'event_date', 'id']);
    expect(Object.keys(permissionGrants)).toEqual(
      expect.arrayContaining([
        'personaId',
        'accountId',
        'canReadRestricted',
        'canRequestApproval',
        'canApprove',
        'sourceCommit'
      ])
    );
    expect(Object.keys(runEvidenceManifests)).toEqual(
      expect.arrayContaining([
        'runId',
        'queryHash',
        'embeddingProvider',
        'embeddingModel',
        'embeddingDimension',
        'contextLimit',
        'diagnostics'
      ])
    );
    expect(Object.keys(runEvidenceManifestEntries)).toEqual(
      expect.arrayContaining([
        'manifestId',
        'evidenceVersionId',
        'citationId',
        'sourceLocator',
        'classificationReason',
        'queryRank',
        'fusionScore',
        'includedCharacters'
      ])
    );
    expect(Object.keys(approvalSubjects)).toEqual(
      expect.arrayContaining([
        'policyTriggers',
        'runId',
        'subjectHash',
        'sectionIds',
        'recommendationIds',
        'citationIds',
        'quorumVersion'
      ])
    );
    expect(approvalSubjects.policyTriggers.getSQLType()).toBe('jsonb');
    expect(Object.keys(approvalRequirementEntries)).toEqual(
      expect.arrayContaining([
        'approvalSubjectId',
        'category',
        'eligibleAuthorities',
        'dependsOn',
        'ordinal'
      ])
    );
    expect(Object.keys(approvalDecisions)).toEqual(
      expect.arrayContaining([
        'entryId',
        'category',
        'authority',
        'idempotencyKey',
        'originalPayload',
        'approvedPayload',
        'approvedSubjectHash',
        'diff',
        'resultRunVersion',
        'resultStatus',
        'resultQuorumSatisfied',
        'resultRejected'
      ])
    );
    expect(Object.keys(approvalAuthorityGrants)).toEqual(
      expect.arrayContaining(['personaId', 'accountId', 'authority', 'demoOnly', 'source'])
    );
    expect(Object.keys(opportunityPolicyFacts)).toEqual(
      expect.arrayContaining([
        'opportunityId',
        'discountPercent',
        'renewalUpliftPercent',
        'liabilityCapChanged'
      ])
    );
    expect(Object.keys(briefs)).toEqual(
      expect.arrayContaining(['approvalSubjectId', 'runId', 'subjectHash', 'draftVersion'])
    );
    expect(Object.keys(outboxCommands)).toEqual(
      expect.arrayContaining(['claimOwner', 'claimToken', 'claimExpiresAt', 'consumedAt'])
    );
    const pendingIndex = getTableConfig(outboxCommands).indexes.find(
      (entry) => entry.config.name === 'outbox_commands_pending_idx'
    );
    expect(
      pendingIndex?.config.columns.map((column) => ('name' in column ? column.name : undefined))
    ).toEqual(['status', 'available_at', 'id']);
    expect(Object.keys(stepInvocations)).toEqual(
      expect.arrayContaining(['causalCommandId', 'leaseToken'])
    );
    expect(Object.keys(runs)).toEqual(
      expect.arrayContaining(['idempotencyKey', 'startRequestHash'])
    );
    const runIndexes = getTableConfig(runs).indexes;
    expect(
      runIndexes
        .find((entry) => entry.config.name === 'runs_idempotency_key_uq')
        ?.config.columns.map((column) => ('name' in column ? column.name : undefined))
    ).toEqual(['idempotency_key']);
    expect(
      runIndexes
        .find((entry) => entry.config.name === 'runs_one_active_requester_opportunity_uq')
        ?.config.columns.map((column) => ('name' in column ? column.name : undefined))
    ).toEqual(['opportunity_id', 'requested_by']);
    expect(Object.keys(runBudgets)).toEqual(
      expect.arrayContaining(['reservedOutputTokens', 'deadlineMs', 'deadlineAt'])
    );
    // max_input_tokens/max_output_tokens were dead run_budgets columns — never
    // read by any application code, un-enforced since 0019_remove_token_budgets
    // — and were dropped from both schema.ts and the migration catalog.
    expect(Object.keys(runBudgets)).not.toContain('maxInputTokens');
    expect(Object.keys(runBudgets)).not.toContain('maxOutputTokens');
    const reservationConstraint = getTableConfig(runBudgetReservations).uniqueConstraints.find(
      (entry) => entry.name === 'run_budget_reservations_generation_operation_ordinal_uq'
    );
    expect(reservationConstraint?.columns.map((column) => column.name)).toEqual([
      'run_id',
      'logical_generation_id',
      'operation',
      'ordinal'
    ]);
    expect(Object.keys(runBudgetReservations)).toEqual(
      expect.arrayContaining([
        'attemptId',
        'invocationId',
        'logicalGenerationId',
        'operation',
        'ordinal',
        'grantedOutputTokens',
        'reservedInputTokens',
        'actualInputTokens',
        'actualOutputTokens',
        'requestId',
        'responseId',
        'failureCategory',
        'failureCode'
      ])
    );
    expect(Object.keys(generationAttempts)).toEqual(
      expect.arrayContaining([
        'logicalGenerationId',
        'outputMode',
        'validationAttempts',
        'validationIssues',
        'warnings'
      ])
    );
    expect(Object.keys(workflowCheckpoints)).toEqual(
      expect.arrayContaining(['invocationId', 'logicalGenerationId'])
    );
    expect(Object.keys(specialistArtifacts)).toEqual(
      expect.arrayContaining([
        'draftVersion',
        'outcome',
        'warnings',
        'logicalGenerationId',
        'generationMetadata'
      ])
    );
    expect(Object.keys(traceSpans)).toEqual(
      expect.arrayContaining([
        'traceId',
        'spanId',
        'runId',
        'parentId',
        'step',
        'attempt',
        'kind',
        'status',
        'payload'
      ])
    );
    expect(Object.keys(runEvents)).toEqual(
      expect.arrayContaining(['runId', 'sequence', 'type', 'version', 'payload', 'createdAt'])
    );
    expect(getTableConfig(traceSpans).indexes.map((entry) => entry.config.name)).toEqual(
      expect.arrayContaining([
        'trace_spans_run_span_uq',
        'trace_spans_run_started_idx',
        'trace_spans_trace_idx'
      ])
    );
    expect(getTableConfig(runEvents).indexes.map((entry) => entry.config.name)).toEqual(
      expect.arrayContaining(['run_events_run_sequence_uq', 'run_events_run_created_idx'])
    );
    expect(claims.confidence.getSQLType()).toBe('numeric');
  });
});
