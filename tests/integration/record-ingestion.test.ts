import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { ingestFixtureRecords } from '../../scripts/ingest.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const sql = postgres(databaseUrl, { max: 1 });
afterAll(async () => sql.end({ timeout: 5 }));

describe('record-only canonical ingestion', () => {
  it('is idempotent, stores classification provenance, and never creates embeddings', async () => {
    await ingestFixtureRecords({ root: 'fixtures/cato', databaseUrl });
    const second = await ingestFixtureRecords({ root: 'fixtures/cato', databaseUrl });
    const pricing = await sql<{
      sensitivity: string; classification_reason: string | null; policy_hash: string | null; embedding: unknown;
    }[]>`select sensitivity, classification_reason, policy_hash, embedding from evidence_versions where id = 'pricing:PN-4004:0'`;

    expect(second.inserted).toEqual({ personas: 0, grants: 0, accounts: 0, opportunities: 0, contacts: 0, documents: 0, chunks: 0 });
    expect(pricing).toEqual([expect.objectContaining({
      sensitivity: 'restricted', classification_reason: 'policy_sensitive_pricing', embedding: null
    })]);
    expect(pricing[0]?.policy_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
