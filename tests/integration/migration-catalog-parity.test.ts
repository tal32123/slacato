import { readFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { getTableConfig } from '../../packages/infrastructure/node_modules/drizzle-orm/pg-core/utils.js';
import {
  approvalSubjects, briefs, claims, evidenceVersions, outboxCommands, runBudgetReservations,
  permissionGrants, runBudgets, runEvidenceManifestEntries, runEvidenceManifests, stepInvocations
} from '@slacato/infrastructure/db/schema';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databasePrefix = 'catohw_catalog_';
const databaseNamePattern = /^catohw_catalog_[a-z0-9]{16}$/;
const migrationFiles = Array.from({ length: 9 }, (_, index) =>
  resolve(process.cwd(), 'drizzle', `${String(index).padStart(4, '0')}_${[
    'initial', 'delivery_claim_leases', 'causal_command_consumption', 'approval_snapshot_linkage',
    'persisted_run_budgets', 'active_causal_command', 'restricted_opportunity_grants',
    'dead_letter_claim_recovery', 'provider_attempt_ledger'
  ][index]}.sql`)
);
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
    await Promise.all([createTemporaryDatabase(cleanName), createTemporaryDatabase(upgradeName)]);
    const clean = postgres(urlForDatabase(cleanName), { max: 1 });
    const upgrade = postgres(urlForDatabase(upgradeName), { max: 1 });
    try {
      await applyMigrations(clean, migrationFiles);
      await applyMigrations(upgrade, migrationFiles.slice(0, 2));
      await applyMigrations(upgrade, migrationFiles.slice(2));
      const [cleanCatalog, upgradeCatalog] = await Promise.all([catalog(clean), catalog(upgrade)]);
      expect(cleanCatalog).toEqual(upgradeCatalog);

      const serialized = JSON.stringify(cleanCatalog).toLowerCase();
      expect(serialized).toContain('"name":"vector"');
      expect(serialized).toContain('"column_name":"embedding","type":"vector","typmod":-1');
      expect(serialized).toContain('"column_name":"lexical_content"');
      expect(serialized).toContain('vector_dims(embedding) = embedding_dimension');
      expect(serialized).toContain('briefs_approval_subject_snapshot_fk');
      expect(serialized).toContain('step_invocations_one_active_causal_command_uq');
      expect(serialized).toContain('run_budget_reservations_attempt_fk');
      expect(serialized).not.toContain('hnsw');
    } finally {
      await clean.end({ timeout: 1 });
      await upgrade.end({ timeout: 1 });
    }
  });

  it('exposes the final SQL columns and constraints through the runtime mapping', () => {
    expect(evidenceVersions.embedding.getSQLType()).toBe('vector');
    expect(evidenceVersions.lexicalContent.generated?.as).toBeDefined();
    expect(Object.keys(permissionGrants)).toEqual(expect.arrayContaining(['personaId', 'accountId', 'canReadRestricted']));
    expect(Object.keys(runEvidenceManifests)).toEqual(expect.arrayContaining(['runId']));
    expect(Object.keys(runEvidenceManifestEntries)).toEqual(expect.arrayContaining(['manifestId', 'evidenceVersionId']));
    expect(Object.keys(approvalSubjects)).toEqual(expect.arrayContaining(['policyTriggers', 'runId', 'subjectHash']));
    expect(approvalSubjects.policyTriggers.getSQLType()).toBe('jsonb');
    expect(Object.keys(briefs)).toEqual(expect.arrayContaining(['approvalSubjectId', 'runId', 'subjectHash']));
    expect(Object.keys(outboxCommands)).toEqual(expect.arrayContaining(['claimOwner', 'claimToken', 'claimExpiresAt', 'consumedAt']));
    const pendingIndex = getTableConfig(outboxCommands).indexes.find((entry) => entry.config.name === 'outbox_commands_pending_idx');
    expect(pendingIndex?.config.columns.map((column) => 'name' in column ? column.name : undefined)).toEqual(['status', 'available_at', 'id']);
    expect(Object.keys(stepInvocations)).toEqual(expect.arrayContaining(['causalCommandId', 'leaseToken']));
    expect(Object.keys(runBudgets)).toEqual(expect.arrayContaining(['reservedOutputTokens']));
    expect(Object.keys(runBudgetReservations)).toEqual(expect.arrayContaining([
      'attemptId', 'invocationId', 'operation', 'ordinal', 'grantedOutputTokens', 'reservedInputTokens',
      'actualInputTokens', 'actualOutputTokens', 'requestId', 'responseId', 'failureCategory', 'failureCode'
    ]));
    expect(claims.confidence.getSQLType()).toBe('numeric');
  });
});
