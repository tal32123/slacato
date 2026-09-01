import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CANONICAL_FIXTURE_COMMIT, StartDealBrief } from '@slacato/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabaseClient,
  type DatabaseClient,
  PostgresDealBriefAccessControl,
  PostgresWorkflowStore
} from '../../packages/infrastructure/src/index';

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databaseName = `catohw_active_scope_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const databaseNamePattern = /^catohw_active_scope_[a-z0-9]{16}$/;

function databaseUrlFor(name: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const databaseUrl = databaseUrlFor(databaseName);

describe('active run requester scope against a real database', () => {
  let admin: Sql;
  let seedDatabase: Sql;
  let database: DatabaseClient;

  beforeAll(async () => {
    if (!databaseNamePattern.test(databaseName))
      throw new Error(`Refusing to create non-test database ${databaseName}`);
    admin = postgres(databaseUrlFor('postgres'), { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    seedDatabase = postgres(databaseUrl, { max: 1 });
    await migrate(drizzle(seedDatabase), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    database = createDatabaseClient(databaseUrl, 2);
  }, 120_000);

  afterAll(async () => {
    await database?.close();
    await seedDatabase?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await admin?.end({ timeout: 5 });
  });

  it('creates a distinct active run for each authorized requester evidence scope', async () => {
    const accountId = 'ACC-9303';
    const opportunityId = 'OPP-9303';
    const firstRequester = 'USR-93031';
    const secondRequester = 'USR-93032';

    await seedDatabase`insert into personas (id, display_name, role, source_commit) values
      (${firstRequester}, 'CRM-only Requester', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT}),
      (${secondRequester}, 'Pricing-enabled Requester', 'Account Owner', ${CANONICAL_FIXTURE_COMMIT})`;
    await seedDatabase`insert into accounts (id, name) values (${accountId}, 'Requester Scope Account')`;
    await seedDatabase`insert into opportunities (id, account_id, name, restricted)
      values (${opportunityId}, ${accountId}, 'Requester Scope Opportunity', false)`;
    await seedDatabase`insert into permission_grants
      (id, persona_id, account_id, source_type, can_read, can_read_restricted,
        can_request_approval, can_approve, sensitive_pricing, source_commit)
      values
      ('grant-f03-first-crm', ${firstRequester}, ${accountId}, 'salesforce', true, false, true, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      ('grant-f03-second-crm', ${secondRequester}, ${accountId}, 'salesforce', true, false, true, false, false, ${CANONICAL_FIXTURE_COMMIT}),
      ('grant-f03-second-pricing', ${secondRequester}, ${accountId}, 'pricing', true, false, false, false, true, ${CANONICAL_FIXTURE_COMMIT})`;

    const start = new StartDealBrief(
      new PostgresWorkflowStore(database),
      new PostgresDealBriefAccessControl(database),
      { provider: 'mock', model: 'mock-brief' }
    );
    const first = await start.execute({
      opportunityId,
      requestedBy: firstRequester,
      idempotencyKey: 'f03-first-start'
    });
    const second = await start.execute({
      opportunityId,
      requestedBy: secondRequester,
      idempotencyKey: 'f03-second-start'
    });

    expect(first.disposition).toBe('created');
    expect(second.disposition).toBe('created');
    expect(second.runId).not.toBe(first.runId);
    expect(
      await database.sql<{ id: string; requested_by: string; status: string }[]>`
        select id, requested_by, status from runs
        where opportunity_id = ${opportunityId}
          and status in ('created','retrieving','specialists_running','synthesizing','validating','awaiting_approval','finalizing')
        order by requested_by`
    ).toEqual([
      { id: first.runId, requested_by: firstRequester, status: 'created' },
      { id: second.runId, requested_by: secondRequester, status: 'created' }
    ]);
  }, 120_000);
});
