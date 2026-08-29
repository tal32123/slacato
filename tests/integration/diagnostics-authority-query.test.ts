import { afterAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, PostgresApprovalAuthorityQuery } from '@slacato/infrastructure';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const client = createDatabaseClient(databaseUrl, 2);
const query = new PostgresApprovalAuthorityQuery(client);

afterAll(async () => { await client.close(); });

describe('PostgresApprovalAuthorityQuery', () => {
  it('loads canonical account-scoped authority for a persona without evidence grants', async () => {
    await expect(query.forPersona('USR-5006')).resolves.toEqual([
      { accountId: 'ACC-2003', authorities: ['legal_reviewer'] }
    ]);
  });
});
