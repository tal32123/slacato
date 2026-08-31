import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StartDealBrief } from '@slacato/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabaseClient,
  PostgresDealBriefAccessControl,
  PostgresWorkflowStore
} from '../../packages/infrastructure/src/index';
import { ingestFixtureRecords } from '../../scripts/ingest';
import { assertResettableDatabase, resetDemoState } from '../../scripts/reset-demo';

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

describe('demo reset safety rails', () => {
  it('refuses a database it does not recognize as a local demo', () => {
    expect(() =>
      assertResettableDatabase('postgres://user:pw@db.example.com:5432/slacato_demo')
    ).toThrow(/Refusing to reset/);
    expect(() => assertResettableDatabase('postgres://user:pw@127.0.0.1:5432/production')).toThrow(
      /Refusing to reset/
    );
  });

  it('accepts a local demo database without ceremony', () => {
    expect(assertResettableDatabase('postgres://user:pw@127.0.0.1:54329/slacato_demo')).toBe(
      'slacato_demo'
    );
  });

  it('requires both the flag and the named database before overriding', () => {
    const url = 'postgres://user:pw@db.example.com:5432/anything';
    expect(() => assertResettableDatabase(url, ['--force-unsafe-database'], {})).toThrow(
      /Refusing to reset/
    );
    expect(() =>
      assertResettableDatabase(url, [], { SLACATO_RESET_CONFIRM_DATABASE: 'anything' })
    ).toThrow(/Refusing to reset/);
    expect(() =>
      assertResettableDatabase(url, ['--force-unsafe-database'], {
        SLACATO_RESET_CONFIRM_DATABASE: 'a-different-database'
      })
    ).toThrow(/Refusing to reset/);
    expect(
      assertResettableDatabase(url, ['--force-unsafe-database'], {
        SLACATO_RESET_CONFIRM_DATABASE: 'anything'
      })
    ).toBe('anything');
  });
});

describe('demo reset restores a demoable state', () => {
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

  it('releases the opportunity a finished demo pass left held, keeping its history', async () => {
    const client = createDatabaseClient(databaseUrl, 2);
    const start = new StartDealBrief(
      new PostgresWorkflowStore(client),
      new PostgresDealBriefAccessControl(client),
      { provider: 'mock', model: 'mock-brief' }
    );
    const opportunityId = 'OPP-1001';
    const requestedBy = 'USR-5001';

    // A first demo pass leaves an active run behind, and every later pass joins it instead of
    // starting work - which is exactly what breaks the generate-and-watch steps.
    const first = await start.execute({ opportunityId, requestedBy, idempotencyKey: 'pass-one' });
    expect(first.disposition).toBe('created');
    const blocked = await start.execute({ opportunityId, requestedBy, idempotencyKey: 'pass-two' });
    expect(blocked).toEqual({ runId: first.runId, disposition: 'joined' });

    // An approval subject carrying a recorded decision is single-use: the inbox step cannot repeat
    // against it. The reset must retain it as history rather than deleting it.
    await client.sql`insert into approval_subjects (id, run_id, draft_version, subject_hash, payload, policy_triggers)
      values ('subject-reset-test', ${first.runId}, 1, ${'a'.repeat(64)}, '{}'::jsonb, ${JSON.stringify(['legal_terms'])}::jsonb)`;
    const eventsBefore = await client.sql<{ count: number }[]>`
      select count(*)::int count from run_events where run_id = ${first.runId}`;
    const eventCountBefore = eventsBefore[0]?.count ?? 0;
    expect(eventCountBefore).toBeGreaterThan(0);

    const result = await resetDemoState({ databaseUrl, opportunityIds: [opportunityId] });
    expect(result.cancelled).toEqual([
      {
        runId: first.runId,
        opportunityId,
        requestedBy,
        previousStatus: 'created'
      }
    ]);

    // Cancellation retains history: the run, its events, and its approval subject all survive.
    const [cancelled] = await client.sql<
      { status: string }[]
    >`select status from runs where id = ${first.runId}`;
    expect(cancelled?.status).toBe('cancelled');
    const eventsAfter = await client.sql<{ count: number }[]>`
      select count(*)::int count from run_events where run_id = ${first.runId}`;
    expect(eventsAfter[0]?.count ?? 0).toBeGreaterThanOrEqual(eventCountBefore);
    const retainedSubjects = await client.sql<{ id: string }[]>`
      select id from approval_subjects where run_id = ${first.runId}`;
    expect(retainedSubjects.map(({ id }) => id)).toEqual(['subject-reset-test']);

    // And the demo is walkable again: the next Generate Brief starts new work rather than joining
    // finished work, which is the precondition for a fresh approval subject the inbox can act on.
    const second = await start.execute({
      opportunityId,
      requestedBy,
      idempotencyKey: 'pass-three'
    });
    expect(second.disposition).toBe('created');
    expect(second.runId).not.toBe(first.runId);
    const subjectsForFreshRun = await client.sql<{ count: number }[]>`
      select count(*)::int count from approval_subjects where run_id = ${second.runId}`;
    expect(subjectsForFreshRun[0]?.count).toBe(0);

    // Running the reset again is safe and reports the state honestly rather than failing.
    const repeated = await resetDemoState({ databaseUrl, opportunityIds: [opportunityId] });
    expect(repeated.cancelled.map(({ runId }) => runId)).toEqual([second.runId]);
    const idempotent = await resetDemoState({ databaseUrl, opportunityIds: [opportunityId] });
    expect(idempotent).toMatchObject({ cancelled: [], alreadyClear: [opportunityId] });

    await client.close();
  }, 120_000);
});
