import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResetSandbox, type SandboxResetReport } from '../packages/core/src/index.js';
import {
  assertResettableDatabase,
  createDatabaseClient,
  type DatabaseClient,
  databaseNameFrom,
  PostgresDealBriefAccessControl,
  PostgresSandboxResetStore
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
 * The uniqueness rule is a real concurrency control and is left alone. This removes the run history
 * instead - every run, approval subject, decision, brief, event, trace, queued command and run-bound
 * audit row - so the sandbox reads as if nothing had ever been run in it. What was ingested into it
 * stays: personas, grants, accounts, opportunities, contacts, documents and evidence versions with
 * their embeddings are untouched, because re-creating them costs a paid re-ingest and re-embed and
 * would leave the readiness probe's index check failing until it finished.
 *
 * This is the same operation the product's own "Reset sandbox" control performs, through the same
 * application command and the same store, so the CLI and the button cannot drift apart.
 *
 * Usage:
 *   pnpm demo:reset             erase the run history in the local demo database
 *   pnpm demo:reset --dry-run   report what would be erased and change nothing
 */

const DEFAULT_DATABASE_URL = 'postgres://slacato:slacato@127.0.0.1:54329/slacato_demo';

export { assertResettableDatabase } from '../packages/infrastructure/src/index.js';

/**
 * Erases, or counts, everything a demo pass produced in a sandbox database.
 *
 * The command layer authorizes the actor before it touches anything, so the CLI names the persona
 * it is acting as rather than bypassing the check the UI is held to.
 */
export async function resetDemoState(
  options: Readonly<{ databaseUrl: string; dryRun?: boolean; actorId?: string }>
): Promise<SandboxResetReport & { dryRun: boolean }> {
  const dryRun = options.dryRun ?? false;
  const client = createDatabaseClient(options.databaseUrl, 2);
  try {
    const access = new PostgresDealBriefAccessControl(client);
    const store = new PostgresSandboxResetStore(client, databaseNameFrom(options.databaseUrl));
    const reset = new ResetSandbox(store, access);
    const actorId = options.actorId ?? (await firstEntitledActor(store, client));
    const report = dryRun ? await reset.preview({ actorId }) : await reset.execute({ actorId });
    return { ...report, dryRun };
  } finally {
    await client.close();
  }
}

/**
 * Picks a persona the sandbox itself already trusts to clear it.
 *
 * The CLI has no session, so it has to choose an actor. Choosing one the store would authorize
 * anyway - rather than inventing an unchecked "system" identity - keeps the CLI inside the same
 * authorization rule as the button, and puts a real persona in the audit record it leaves behind.
 */
async function firstEntitledActor(
  store: PostgresSandboxResetStore,
  client: DatabaseClient
): Promise<string> {
  const personas = await client.sql<{ id: string }[]>`select id from personas order by id`;
  for (const persona of personas) if (await store.mayReset(persona.id)) return persona.id;
  throw new Error(
    'No persona in this database is entitled to reset it. Run `pnpm ingest:records` first.'
  );
}

/** Runs the demo-reset CLI and reports what it erased. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const database = assertResettableDatabase(databaseUrl, argv);
  const dryRun = argv.includes('--dry-run');
  process.stdout.write(
    `${dryRun ? 'Inspecting' : 'Resetting'} demo state in database "${database}" on ${new URL(databaseUrl).hostname}\n`
  );
  const report = await resetDemoState({ databaseUrl, dryRun });
  const verb = dryRun ? 'would erase' : 'erased';
  for (const [label, value] of Object.entries(report.tally))
    process.stdout.write(`  ${verb} ${value} ${label}\n`);
  process.stdout.write(
    `Retained ${report.retained.evidenceVersions} evidence versions, ${report.retained.opportunities} opportunities, ` +
      `and ${report.retained.personas} personas. The next Generate Brief starts a new run.\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
