import { afterAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, PostgresCanonicalPersonaDirectory } from '@slacato/infrastructure';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const client = createDatabaseClient(databaseUrl, 2);
const directory = new PostgresCanonicalPersonaDirectory(client);

afterAll(async () => { await client.close(); });

describe('PostgresCanonicalPersonaDirectory', () => {
  it('loads canonical ingested personas with normalized grants', async () => {
    const persona = await directory.findById('USR-5001');

    expect(persona).toMatchObject({ userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner' });
    expect(persona?.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'ACC-2001', sourceType: 'gong_summary', canRead: true }),
      expect.objectContaining({ accountId: 'ACC-2001', sourceType: 'gong_transcript', canRead: true })
    ]));
  });

  it('does not synthesize an arbitrary identity', async () => {
    await expect(directory.findById('USR-9999')).resolves.toBeUndefined();
  });

  it('excludes non-fixture personas that share the workflow database', async () => {
    const personas = await directory.list();

    expect(personas.map((persona) => persona.userId)).toEqual([
      'USR-5007', 'USR-5001', 'USR-5003', 'USR-5002', 'USR-5005', 'USR-5004'
    ]);
  });
});
