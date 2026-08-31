import {
  CANONICAL_FIXTURE_COMMIT,
  type SandboxResetReport,
  type SandboxResetStore,
  type SandboxResetTally
} from '@slacato/core';
import type { Sql, TransactionSql } from 'postgres';
import type { DatabaseClient } from '../client.js';

/**
 * Every table whose rows exist only because a run happened, ordered children before parents.
 *
 * This is the deletion order, and it is spelled out rather than derived at runtime: a reset that
 * discovered its own scope from the live catalogue would silently widen the moment someone added a
 * table, which is the opposite of what a destructive operation should do. `tests/integration/
 * sandbox-reset.test.ts` closes the other half of that trade by walking `pg_constraint` and failing
 * if the database grows a run-scoped table this list does not name.
 *
 * `trace_spans` earns its place by column, not by constraint: it carries `run_id` but declares no
 * foreign key to `runs`, so a purely constraint-derived list would leave the traces behind.
 */
export const RUN_SCOPED_TABLES = [
  'citations',
  'run_budget_reservations',
  'generation_attempts',
  'workflow_checkpoints',
  'approval_decisions',
  'approval_requirement_entries',
  'briefs',
  'claims',
  'specialist_artifacts',
  'run_evidence_manifest_entries',
  'run_evidence_manifests',
  'step_invocations',
  'outbox_commands',
  'approval_subjects',
  'context_checkpoints',
  'run_budgets',
  'run_events',
  'trace_spans',
  'audit_events',
  'runs'
] as const;

/**
 * Tables a reset must never touch, named so the boundary is reviewable rather than implied.
 *
 * `evidence_versions` and `document_versions` are the expensive half: re-creating them costs a
 * paid re-ingest and re-embed, and until that finished the readiness probe's index check - which
 * requires one consistent embedding profile across the whole corpus - would report the API not
 * ready and brief generation would be disabled. `auth_sessions` is here for a smaller but sharper
 * reason: wiping it would sign the operator out mid-click and invalidate the CSRF token their own
 * reset request was carrying.
 */
export const SANDBOX_PRESERVED_TABLES = [
  'accounts',
  'approval_authority_grants',
  'auth_sessions',
  'contacts',
  'document_versions',
  'evidence_versions',
  'opportunities',
  'opportunity_policy_facts',
  'permission_grants',
  'personas'
] as const;

type SqlExecutor = Sql | TransactionSql;

/** Statuses a run can still leave on its own; anything else is a resting or finished run. */
const ACTIVE_RUN_STATUSES = [
  'created',
  'retrieving',
  'specialists_running',
  'synthesizing',
  'validating',
  'awaiting_approval',
  'finalizing'
];

const EMPTY_TALLY: SandboxResetTally = {
  runs: 0,
  activeRuns: 0,
  approvalSubjects: 0,
  approvalDecisions: 0,
  briefs: 0,
  runEvents: 0,
  traceSpans: 0,
  queuedCommands: 0,
  auditEvents: 0
};

/**
 * Returns a sandbox to a never-run state without disturbing anything that was ingested into it.
 *
 * The reset is a single transaction over the run-scoped tables above. That matters more than it
 * looks: these tables reference one another through fourteen foreign keys, so a reset that failed
 * halfway through a sequence of independent statements would leave briefs pointing at deleted
 * approval subjects and claims pointing at deleted artifacts - a database that is neither the state
 * before nor the state after. Committing once means the sandbox is either fully clean or fully
 * untouched, and pressing the button twice is simply the same transaction finding nothing to do.
 */
export class PostgresSandboxResetStore implements SandboxResetStore {
  /** Creates the sandbox reset store for a database already designated as a sandbox. */
  public constructor(
    private readonly database: DatabaseClient,
    private readonly databaseName: string
  ) {}

  /**
   * Reports whether a persona may erase the sandbox everyone in the demo shares.
   *
   * The rule reuses the predicate that already decides who may create the work a reset destroys:
   * `PostgresDealBriefAccessControl.authorizeStart` requires a live canonical read grant on the
   * opportunity plus `can_request_approval` on its account, and this asks for the same pair against
   * any opportunity at all. So a persona can clear the sandbox exactly when they are one of the
   * personas capable of filling it, and the demo's deliberately unauthorized identities - the
   * requester with no approval right, the legal reviewer, the restricted leader without a grant -
   * cannot, which is the same persona boundary every other screen in the product enforces.
   *
   * The looser "any opportunity" rather than "every canonical opportunity" is a considered choice:
   * only one fixture persona holds all three, and a reset only that persona could perform would
   * push the operator to switch identity before every demo pass.
   */
  public async mayReset(actorId: string): Promise<boolean> {
    const rows = await this.database.sql<{ entitled: boolean }[]>`
      select exists (
        select 1
        from authorized_opportunity_grants opportunity_grant
        join permission_grants permission
          on permission.persona_id = opportunity_grant.persona_id
          and permission.account_id = opportunity_grant.account_id
          and permission.source_commit = ${CANONICAL_FIXTURE_COMMIT}
          and permission.can_request_approval
        where opportunity_grant.persona_id = ${actorId}
          and opportunity_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
      ) as entitled`;
    return rows[0]?.entitled ?? false;
  }

  /** Counts what a reset would remove right now, without changing anything. */
  public async preview(): Promise<SandboxResetReport> {
    return this.database.sql.begin(async (sql) => ({
      database: this.databaseName,
      tally: await countRunScopedRecords(sql),
      retained: await countRetainedFixtures(sql)
    }));
  }

  /**
   * Erases every run-scoped record and records the reset itself in the audit trail.
   *
   * The audit row is written last and inside the same transaction, so the trail can never claim a
   * reset that did not commit. It carries no `run_id` - the runs it describes no longer exist -
   * which is what the nullable column on `audit_events` is for, and is also why a second press
   * cannot erase the first press's record: run-bound audit rows go, run-less ones stay.
   */
  public async erase(input: Readonly<{ actorId: string }>): Promise<SandboxResetReport> {
    return this.database.sql.begin(async (sql) => {
      const tally = await countRunScopedRecords(sql);
      for (const table of RUN_SCOPED_TABLES) {
        // Run-bound audit rows have to go with their runs to satisfy the foreign key. Rows with no
        // run - opaque access denials, and the reset records written below - are not run history
        // and are deliberately kept: `audit_events` is write-only by design, and a reset able to
        // erase the record of a refused access would make the audit trail worth less than the demo.
        if (table === 'audit_events') await sql`delete from audit_events where run_id is not null`;
        else await sql`delete from ${sql(table)}`;
      }
      await sql`insert into audit_events (id, run_id, actor_id, type, payload) values
        (${`audit_${crypto.randomUUID()}`}, null, ${input.actorId}, 'sandbox_reset',
          ${JSON.stringify({ database: this.databaseName, deleted: tally })}::jsonb)`;
      return { database: this.databaseName, tally, retained: await countRetainedFixtures(sql) };
    });
  }
}

/** Counts the run-scoped records present in one consistent snapshot. */
async function countRunScopedRecords(sql: SqlExecutor): Promise<SandboxResetTally> {
  const rows = await sql<
    {
      runs: number;
      active_runs: number;
      approval_subjects: number;
      approval_decisions: number;
      briefs: number;
      run_events: number;
      trace_spans: number;
      queued_commands: number;
      audit_events: number;
    }[]
  >`select
      (select count(*)::integer from runs) as runs,
      (select count(*)::integer from runs where status = any(${ACTIVE_RUN_STATUSES}::text[])) as active_runs,
      (select count(*)::integer from approval_subjects) as approval_subjects,
      (select count(*)::integer from approval_decisions) as approval_decisions,
      (select count(*)::integer from briefs) as briefs,
      (select count(*)::integer from run_events) as run_events,
      (select count(*)::integer from trace_spans) as trace_spans,
      (select count(*)::integer from outbox_commands where status in ('pending', 'claimed')) as queued_commands,
      (select count(*)::integer from audit_events where run_id is not null) as audit_events`;
  const row = rows[0];
  if (row === undefined) return EMPTY_TALLY;
  return {
    runs: row.runs,
    activeRuns: row.active_runs,
    approvalSubjects: row.approval_subjects,
    approvalDecisions: row.approval_decisions,
    briefs: row.briefs,
    runEvents: row.run_events,
    traceSpans: row.trace_spans,
    queuedCommands: row.queued_commands,
    auditEvents: row.audit_events
  };
}

/** Counts the ingested corpus the reset leaves in place, so the report can prove it did. */
async function countRetainedFixtures(sql: SqlExecutor) {
  const rows = await sql<
    { evidence_versions: number; opportunities: number; personas: number }[]
  >`select
      (select count(*)::integer from evidence_versions) as evidence_versions,
      (select count(*)::integer from opportunities) as opportunities,
      (select count(*)::integer from personas) as personas`;
  const row = rows[0];
  return {
    evidenceVersions: row?.evidence_versions ?? 0,
    opportunities: row?.opportunities ?? 0,
    personas: row?.personas ?? 0
  };
}
