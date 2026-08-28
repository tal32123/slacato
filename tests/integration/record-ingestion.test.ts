import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { ingestFixtureRecords } from '../../scripts/ingest.js';
import { CANONICAL_FIXTURE_COMMIT } from '@slacato/core';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const sql = postgres(databaseUrl, { max: 1 });
afterAll(async () => sql.end({ timeout: 5 }));

describe('record-only canonical ingestion', () => {
  it('is idempotent, stores classification provenance, and never creates embeddings', async () => {
    await sql`insert into permission_grants
      (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing, source_commit)
      values ('grant:stale-canonical', 'USR-5001', 'ACC-2001', 'slack', true, false, true, true, false, ${CANONICAL_FIXTURE_COMMIT})
      on conflict (id) do nothing`;
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
    await expect(sql`select id from permission_grants where id = 'grant:stale-canonical'`).resolves.toHaveLength(0);
    await expect(sql<{ role: string; can_request_approval: boolean; can_approve: boolean }[]>`
      select personas.role, bool_and(permission_grants.can_request_approval) as can_request_approval,
        bool_and(permission_grants.can_approve) as can_approve
      from personas join permission_grants on permission_grants.persona_id = personas.id
      where personas.id in ('USR-5001', 'USR-5004', 'USR-5005') and permission_grants.source_commit = ${CANONICAL_FIXTURE_COMMIT}
      group by personas.role order by personas.role
    `).resolves.toEqual([
      { role: 'Account Owner', can_request_approval: true, can_approve: false },
      { role: 'Deal Desk Approver', can_request_approval: true, can_approve: true },
      { role: 'Sales Leader', can_request_approval: true, can_approve: true }
    ]);
  });
});
