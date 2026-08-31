import postgres, { type Sql } from 'postgres';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';

/**
 * Seeds one awaiting-approval run under the restricted account (ACC-2003) with three requirement
 * entries -- one per authority (deal_desk, legal_reviewer, sales_leader) -- and nothing else:
 * `listApprovals` (packages/infrastructure/src/db/queries/approval-query.ts) never reads
 * `approval_subjects.payload`, evidence, documents, or policy facts, so seeding those adds risk
 * without adding coverage for the authority-scoping question this fixture exists to answer.
 *
 * Rows inserted here are never deleted: `approval_requirement_entries` (and its sibling audit
 * tables) are enforced immutable by a database trigger ("rows are immutable"), which is also why
 * the pre-existing approval.spec.ts and run-resume.spec.ts fixtures never clean up after
 * themselves -- it is a deliberate audit-integrity property of the schema, not neglect.
 */
export async function seedTriAuthorityApproval(sql: Sql): Promise<{
  opportunityId: string;
  dealDeskEntryId: string;
  legalEntryId: string;
  salesLeaderEntryId: string;
}> {
  const suffix = `authscope-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const opportunityId = `OPP-${suffix}`;
  const runId = `run-${suffix}`;
  const subjectId = `subject-${suffix}`;
  const dealDeskEntryId = `entry-desk-${suffix}`;
  const legalEntryId = `entry-legal-${suffix}`;
  const salesLeaderEntryId = `entry-leader-${suffix}`;

  await sql`insert into opportunities (id, account_id, name, restricted)
    values (${opportunityId}, 'ACC-2003', 'Authority Scoping Fixture', true)`;
  await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
    values (${runId}, ${opportunityId}, 'USR-5003', 'awaiting_approval', 'mock', 'mock-brief', ${'f'.repeat(64)}, 1)`;
  await sql`insert into approval_subjects (id, run_id, draft_version, subject_hash, payload, quorum_version)
    values (${subjectId}, ${runId}, 1, ${'f'.repeat(64)}, ${sql.json({})}, 'deal-brief-approval-v1')`;
  await sql`insert into approval_requirement_entries (id, approval_subject_id, category, eligible_authorities, ordinal) values
    (${dealDeskEntryId}, ${subjectId}, 'commercial_discount', ${sql.json(['deal_desk'])}, 0),
    (${legalEntryId}, ${subjectId}, 'legal_terms', ${sql.json(['legal_reviewer'])}, 1),
    (${salesLeaderEntryId}, ${subjectId}, 'commercial_discount', ${sql.json(['sales_leader'])}, 2)`;

  return { opportunityId, dealDeskEntryId, legalEntryId, salesLeaderEntryId };
}

export function connect(): Sql {
  return postgres(databaseUrl, { max: 1 });
}
