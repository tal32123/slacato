import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CancelDealBrief } from '../packages/core/src/index.js';
import {
  createDatabaseClient,
  PostgresDealBriefAccessControl,
  PostgresWorkflowStore
} from '../packages/infrastructure/src/index.js';

/**
 * Returns the canonical demo to a state a reviewer can walk from the beginning.
 *
 * `runs_one_active_opportunity_uq` permits one active run per opportunity, and `awaiting_approval`
 * is a resting state, so one complete demo pass leaves the canonical opportunities holding runs
 * that never terminate on their own. Every later pass then joins that run instead of starting one:
 * "Generate Brief" lands on finished work, "watch the work happen" has nothing to watch, and the
 * approval inbox is empty because its entries were already decided.
 *
 * The uniqueness rule is a real concurrency control and is left alone. This script releases the
 * opportunities the supported way instead - the same cancellation the API exposes at
 * `POST /api/runs/:runId/cancel` - which retains every run, event, artifact, and trace it produced.
 * Nothing is deleted. A later run creates a fresh approval subject with undecided entries, which is
 * what restores the approval-inbox steps.
 *
 * Usage:
 *   pnpm demo:reset             cancel active runs for the canonical opportunities
 *   pnpm demo:reset --dry-run   report what would be cancelled and change nothing
 */

const CANONICAL_OPPORTUNITIES = ['OPP-1001', 'OPP-1002', 'OPP-1003'] as const;
const DEFAULT_DATABASE_URL = 'postgres://slacato:slacato@127.0.0.1:54329/slacato_demo';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEMO_DATABASES = new Set(['slacato', 'slacato_demo', 'slacato_openrouter', 'slacato_e2e']);
const OVERRIDE_FLAG = '--force-unsafe-database';
const OVERRIDE_ENV = 'SLACATO_RESET_CONFIRM_DATABASE';

/** Describes one run the reset released, or would release. */
export type ReleasedRun = Readonly<{
  runId: string;
  opportunityId: string;
  requestedBy: string;
  previousStatus: string;
}>;

/** Reports what the reset found and what it changed. */
export type ResetDemoResult = Readonly<{
  database: string;
  dryRun: boolean;
  cancelled: readonly ReleasedRun[];
  alreadyClear: readonly string[];
}>;

/**
 * Refuses to run against anything but a local demo database.
 *
 * A reset cancels live work, so pointing it at the wrong database is the failure worth preventing.
 * The check is deliberately unforgiving: the host must be loopback and the database name must be
 * one of the known demo names. An operator who genuinely means to target something else must both
 * pass an explicit flag and name that exact database in an environment variable, so no single
 * mistyped `DATABASE_URL` can be enough.
 */
export function assertResettableDatabase(
  databaseUrl: string,
  argv: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env
): string {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const host = url.hostname;
  const isLocalDemo = LOCAL_HOSTS.has(host) && DEMO_DATABASES.has(database);
  if (isLocalDemo) return database;
  const overridden =
    argv.includes(OVERRIDE_FLAG) && environment[OVERRIDE_ENV] === database && database.length > 0;
  if (overridden) return database;
  throw new Error(
    `Refusing to reset ${database || '(no database)'} on ${host}: not a recognized local demo database. ` +
      `Expected one of ${[...DEMO_DATABASES].join(', ')} on a loopback host. ` +
      `To override deliberately, pass ${OVERRIDE_FLAG} and set ${OVERRIDE_ENV}=${database || '<database>'}.`
  );
}

/**
 * Cancels every active run holding a canonical opportunity.
 *
 * Cancellation goes through the same application command the API uses, acting as the run's own
 * requester, so the reset cannot release a run a real caller could not have released itself.
 */
export async function resetDemoState(
  options: Readonly<{
    databaseUrl: string;
    dryRun?: boolean;
    opportunityIds?: readonly string[];
  }>
): Promise<ResetDemoResult> {
  const url = new URL(options.databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const opportunityIds = options.opportunityIds ?? CANONICAL_OPPORTUNITIES;
  const client = createDatabaseClient(options.databaseUrl, 2);
  try {
    const active = await client.sql<
      { id: string; opportunity_id: string; requested_by: string; status: string }[]
    >`select id, opportunity_id, requested_by, status from runs
      where opportunity_id = any(${[...opportunityIds]}::text[])
        and status in ('created','retrieving','specialists_running','synthesizing','validating','awaiting_approval','finalizing')
      order by opportunity_id`;
    const cancelled: ReleasedRun[] = [];
    if (!(options.dryRun ?? false)) {
      const cancel = new CancelDealBrief(
        new PostgresWorkflowStore(client),
        new PostgresDealBriefAccessControl(client)
      );
      for (const run of active) {
        await cancel.execute({ runId: run.id, requestedBy: run.requested_by });
      }
    }
    for (const run of active) {
      cancelled.push({
        runId: run.id,
        opportunityId: run.opportunity_id,
        requestedBy: run.requested_by,
        previousStatus: run.status
      });
    }
    const held = new Set(active.map((run) => run.opportunity_id));
    return {
      database,
      dryRun: options.dryRun ?? false,
      cancelled,
      alreadyClear: opportunityIds.filter((opportunityId) => !held.has(opportunityId))
    };
  } finally {
    await client.close();
  }
}

/** Runs the demo-reset CLI and reports what it released. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const database = assertResettableDatabase(databaseUrl, argv);
  const dryRun = argv.includes('--dry-run');
  process.stdout.write(
    `${dryRun ? 'Inspecting' : 'Resetting'} demo state in database "${database}" on ${new URL(databaseUrl).hostname}\n`
  );
  const result = await resetDemoState({ databaseUrl, dryRun });
  for (const run of result.cancelled) {
    process.stdout.write(
      `  ${dryRun ? 'would cancel' : 'cancelled'} ${run.opportunityId} ${run.runId} (was ${run.previousStatus})\n`
    );
  }
  for (const opportunityId of result.alreadyClear) {
    process.stdout.write(`  ${opportunityId} already has no active run\n`);
  }
  process.stdout.write(
    `${result.cancelled.length} run(s) released. History, artifacts, and traces are retained; the next Generate Brief starts fresh work and a fresh approval subject.\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
