import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabaseClient,
  PostgresCanonicalPersonaDirectory,
  type DatabaseClient
} from '@slacato/infrastructure';
import { ingestFixtureRecords } from '../../scripts/ingest.js';

const sourceDatabaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databaseName = `catohw_persona_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const databaseNamePattern = /^catohw_persona_[a-z0-9]{16}$/;
function databaseUrlFor(name: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
const databaseUrl = databaseUrlFor(databaseName);
let admin: Sql | undefined;
let seedDatabase: Sql | undefined;
let client: DatabaseClient;
let directory: PostgresCanonicalPersonaDirectory;

beforeAll(async () => {
  if (!databaseNamePattern.test(databaseName))
    throw new Error(`Refusing to create non-test database ${databaseName}`);
  admin = postgres(databaseUrlFor('postgres'), { max: 1 });
  await admin.unsafe(`create database "${databaseName}"`);
  seedDatabase = postgres(databaseUrl, { max: 1 });
  await migrate(drizzle(seedDatabase), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  await ingestFixtureRecords({ root: 'fixtures/cato', databaseUrl });
  await seedDatabase`insert into personas (id, display_name, role, source_commit)
    values ('USR-9999', 'Non-canonical Persona', 'Account Owner', null)`;
  const databaseClient = createDatabaseClient(databaseUrl, 2);
  client = databaseClient;
  directory = new PostgresCanonicalPersonaDirectory(databaseClient);
});

afterAll(async () => {
  await client?.close();
  await seedDatabase?.end({ timeout: 1 });
  if (admin !== undefined) {
    if (!databaseNamePattern.test(databaseName))
      throw new Error(`Refusing to drop non-test database ${databaseName}`);
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await admin.end({ timeout: 1 });
  }
});

describe('PostgresCanonicalPersonaDirectory', () => {
  it('loads canonical ingested personas with normalized grants', async () => {
    const persona = await directory.findById('USR-5001');

    expect(persona).toMatchObject({ userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner' });
    expect(persona?.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'ACC-2001', sourceType: 'gong_summary', canRead: true }),
      expect.objectContaining({ accountId: 'ACC-2001', sourceType: 'gong_transcript', canRead: true })
    ]));
  });

  it('does not expose a stored persona without canonical fixture provenance by id', async () => {
    await expect(directory.findById('USR-9999')).resolves.toBeUndefined();
  });

  it('lists only personas with canonical fixture provenance in fixture order', async () => {
    const personas = await directory.list();

    expect(personas.map((persona) => persona.userId)).toEqual([
      'USR-5007', 'USR-5006', 'USR-5001', 'USR-5003', 'USR-5002', 'USR-5005', 'USR-5004', 'USR-5008'
    ]);
  });

  it('ignores stale grants that are not bound to canonical fixture provenance', async () => {
    const staleId = 'test:stale-unstamped-grant';
    await client.sql`delete from permission_grants where id = ${staleId}`;
    await client.sql`insert into permission_grants
      (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_approve, sensitive_pricing)
      values (${staleId}, 'USR-5001', 'ACC-2001', 'slack', false, true, true, true)`;
    try {
      const persona = await directory.findById('USR-5001');
      expect(persona?.grants.every((grant) => grant.canRead)).toBe(true);
    } finally {
      await client.sql`delete from permission_grants where id = ${staleId}`;
    }
  });
});
