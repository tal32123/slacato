import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ResetSandbox, StartDealBrief } from '@slacato/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabaseClient,
  PostgresDealBriefAccessControl,
  PostgresSandboxResetStore,
  PostgresWorkflowStore,
  RUN_SCOPED_TABLES,
  SANDBOX_PRESERVED_TABLES
} from '../../packages/infrastructure/src/index';
import { ingestFixtureRecords } from '../../scripts/ingest';

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databaseName = `catohw_reset_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const databaseNamePattern = /^catohw_reset_[a-z0-9]{16}$/;

/** Builds a URL for a database on the configured local server. */
function databaseUrlFor(name: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
const databaseUrl = databaseUrlFor(databaseName);

describe('sandbox reset against a real database', () => {
  let seedDatabase: Sql;
  let admin: Sql;

  beforeAll(async () => {
    if (!databaseNamePattern.test(databaseName))
      throw new Error(`Refusing to create non-test database ${databaseName}`);
    admin = postgres(databaseUrlFor('postgres'), { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    seedDatabase = postgres(databaseUrl, { max: 1 });
    await migrate(drizzle(seedDatabase), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    await ingestFixtureRecords({ root: 'fixtures/cato', databaseUrl });
  }, 120_000);

  afterAll(async () => {
    await seedDatabase?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await admin?.end({ timeout: 5 });
  });

  it('names every run-scoped table in the schema, and only those', async () => {
    // The delete list is hardcoded so a reset cannot silently widen its own scope. This is the
    // other half of that trade: a migration that adds a table reachable from `runs`, or one that
    // merely carries a `run_id`, fails here instead of leaving orphaned rows behind a reset that
    // claims the sandbox is clean.
    const reachable = await seedDatabase<{ table_name: string }[]>`
      with recursive dependent as (
        select 'runs'::text as table_name
        union
        select constraint_table.conrelid::regclass::text
        from pg_constraint constraint_table
        join dependent on constraint_table.confrelid::regclass::text = dependent.table_name
        where constraint_table.contype = 'f'
          and constraint_table.conrelid::regclass::text <> dependent.table_name
      )
      select table_name from dependent
      union
      select column_reference.table_name
      from information_schema.columns column_reference
      join information_schema.tables base
        on base.table_name = column_reference.table_name
        and base.table_schema = column_reference.table_schema
        and base.table_type = 'BASE TABLE'
      where column_reference.table_schema = 'public' and column_reference.column_name = 'run_id'`;
    expect([...reachable.map(({ table_name }) => table_name)].sort()).toEqual(
      [...RUN_SCOPED_TABLES].sort()
    );

    const allTables = await seedDatabase<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`;
    const untouched = allTables
      .map(({ table_name }) => table_name)
      .filter((name) => !RUN_SCOPED_TABLES.includes(name as (typeof RUN_SCOPED_TABLES)[number]))
      .sort();
    expect(untouched).toEqual([...SANDBOX_PRESERVED_TABLES].sort());
  });

  it('entitles the personas who can create work, and no others', async () => {
    const client = createDatabaseClient(databaseUrl, 2);
    const store = new PostgresSandboxResetStore(client, databaseName);
    // Maya owns OPP-1001 and may request approval on it; Harper is the demo's deliberately
    // unauthorized requester and Iris reviews approvals without ever starting a run.
    expect(await store.mayReset('USR-5001')).toBe(true);
    expect(await store.mayReset('USR-5005')).toBe(true);
    expect(await store.mayReset('USR-5007')).toBe(false);
    expect(await store.mayReset('USR-5006')).toBe(false);
    expect(await store.mayReset('USR-0000-nobody')).toBe(false);
    await client.close();
  });

  it('erases the run history, keeps the ingested corpus, and stays safe to repeat', async () => {
    const client = createDatabaseClient(databaseUrl, 2);
    const access = new PostgresDealBriefAccessControl(client);
    const start = new StartDealBrief(new PostgresWorkflowStore(client), access, {
      provider: 'mock',
      model: 'mock-brief'
    });
    const reset = new ResetSandbox(new PostgresSandboxResetStore(client, databaseName), access);
    const opportunityId = 'OPP-1001';
    const requestedBy = 'USR-5001';

    // A first demo pass leaves an active run behind, and every later pass joins it rather than
    // starting work - which is exactly what breaks the generate-and-watch steps.
    const first = await start.execute({ opportunityId, requestedBy, idempotencyKey: 'pass-one' });
    expect(first.disposition).toBe('created');
    const blocked = await start.execute({ opportunityId, requestedBy, idempotencyKey: 'pass-two' });
    expect(blocked).toEqual({ runId: first.runId, disposition: 'joined' });

    // An approval subject carrying a recorded decision is single-use: the inbox step cannot repeat
    // against it, which is why cancelling the run was never enough to restore the demo.
    await client.sql`insert into approval_subjects (id, run_id, draft_version, subject_hash, payload, policy_triggers)
      values ('subject-reset-test', ${first.runId}, 1, ${'a'.repeat(64)}, '{}'::jsonb, ${JSON.stringify(['legal_terms'])}::jsonb)`;
    await client.sql`insert into approval_requirement_entries (id, approval_subject_id, category, eligible_authorities, ordinal)
      values ('entry-reset-test', 'subject-reset-test', 'legal_terms', ${JSON.stringify(['legal_reviewer'])}::jsonb, 0)`;
    await client.sql`insert into approval_decisions (id, approval_subject_id, action, actor_id, entry_id, category, authority,
      idempotency_key, request_hash, original_payload, approved_payload, original_subject_hash, approved_subject_hash,
      result_run_version, result_status, result_quorum_satisfied, result_rejected)
      values ('decision-reset-test', 'subject-reset-test', 'approve_unchanged', 'USR-5006', 'entry-reset-test', 'legal_terms',
        'legal_reviewer', 'idem-reset-test', 'hash-reset-test', '{}'::jsonb, '{}'::jsonb, ${'a'.repeat(64)}, ${'a'.repeat(64)},
        1, 'awaiting_approval', false, false)`;
    await client.sql`insert into trace_spans (id, run_id, kind, status, trace_id, span_id, step, attempt)
      values ('span-reset-test', ${first.runId}, 'step', 'ok', 'trace-reset-test', 'span-reset-test', 'start', 1)`;

    // A refused request leaves an opaque audit row carrying no run. It must outlive the reset:
    // audit_events is write-only by design, and a reset able to erase refusals would be worse than
    // no audit trail at all, because it would look like one.
    await access.recordOpaqueDenial({ actorId: 'USR-5007', reason: 'forbidden' });

    const corpusBefore = await embeddingCorpus(client.sql);
    expect(corpusBefore.total).toBeGreaterThan(0);
    expect(corpusBefore.profiles).toBe(1);

    const preview = await reset.preview({ actorId: requestedBy });
    expect(preview.database).toBe(databaseName);
    expect(preview.tally).toMatchObject({
      runs: 1,
      activeRuns: 1,
      approvalSubjects: 1,
      approvalDecisions: 1
    });
    // StartDealBrief records its own authorization trace alongside the one inserted above.
    expect(preview.tally.traceSpans).toBeGreaterThan(1);
    expect(preview.tally.runEvents).toBeGreaterThan(0);
    // Previewing changes nothing.
    expect((await client.sql`select id from runs`).length).toBe(1);

    const erased = await reset.execute({ actorId: requestedBy });
    expect(erased.tally).toEqual(preview.tally);

    for (const table of RUN_SCOPED_TABLES) {
      if (table === 'audit_events') continue;
      const rows = await client.sql`select 1 from ${client.sql(table)} limit 1`;
      expect({ table, rows: rows.length }).toEqual({ table, rows: 0 });
    }

    // The ingested corpus - and the single embedding profile the readiness index check requires -
    // is exactly as it was, so generation is still possible without a re-ingest.
    expect(await embeddingCorpus(client.sql)).toEqual(corpusBefore);
    expect(erased.retained).toEqual({
      evidenceVersions: corpusBefore.total,
      opportunities: 3,
      personas: 8
    });

    const audits = await client.sql<{ type: string; actor_id: string; run_id: string | null }[]>`
      select type, actor_id, run_id from audit_events order by type`;
    expect(audits).toEqual([
      { type: 'deal_brief_access_denied', actor_id: 'USR-5007', run_id: null },
      { type: 'sandbox_reset', actor_id: requestedBy, run_id: null }
    ]);

    // The demo is walkable again: the next Generate Brief starts new work rather than joining
    // finished work, which is the precondition for a fresh approval subject the inbox can act on.
    const second = await start.execute({
      opportunityId,
      requestedBy,
      idempotencyKey: 'pass-three'
    });
    expect(second.disposition).toBe('created');
    expect(second.runId).not.toBe(first.runId);

    // Pressing it twice is not an error, and the second press cannot erase the first press's own
    // audit record: run-bound audit rows go with their runs, run-less ones stay.
    await reset.execute({ actorId: requestedBy });
    const repeated = await reset.execute({ actorId: requestedBy });
    expect(repeated.tally).toEqual({
      runs: 0,
      activeRuns: 0,
      approvalSubjects: 0,
      approvalDecisions: 0,
      briefs: 0,
      runEvents: 0,
      traceSpans: 0,
      queuedCommands: 0,
      auditEvents: 0
    });
    const resetAudits = await client.sql<{ count: number }[]>`
      select count(*)::int count from audit_events where type = 'sandbox_reset'`;
    expect(resetAudits[0]?.count).toBe(3);
    expect(await embeddingCorpus(client.sql)).toEqual(corpusBefore);

    // The reset clears these tables with `truncate` precisely because the schema forbids deleting
    // from them. It must not have loosened that: the application still cannot rewrite its own
    // record of what it did, which is the guarantee the append-only triggers exist to make.
    await expect(client.sql`delete from audit_events`).rejects.toThrow(/immutable|append/i);
    await expect(client.sql`delete from evidence_versions`).rejects.toThrow(/immutable/i);

    await client.close();
  }, 120_000);
});

/** Reports the invariant the readiness index probe checks: one profile across a non-empty corpus. */
async function embeddingCorpus(sql: Sql): Promise<{ total: number; profiles: number }> {
  const rows = await sql<{ total: number; profiles: number }[]>`
    select count(*)::integer as total,
      count(distinct row(embedding_provider, embedding_model, embedding_dimension,
        embedding_profile, embedding_version, embedding_normalization))::integer as profiles
    from evidence_versions`;
  return { total: rows[0]?.total ?? 0, profiles: rows[0]?.profiles ?? 0 };
}
