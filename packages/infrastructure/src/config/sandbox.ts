import type { Env } from './env.js';

/**
 * Decides, once, whether a process is allowed to erase the database it is pointed at.
 *
 * The failure this exists to prevent is a reset reaching data nobody meant to lose - the same
 * build serves a public deployment, so "it is only a demo" is an assumption about configuration,
 * never about the code. Every decision here is therefore opt-in and explicit: nothing is inferred
 * from `NODE_ENV`, which says how a build was compiled and nothing at all about which database it
 * is connected to.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Database names created by this repository's own local demo and test tooling. */
export const DEMO_DATABASES: ReadonlySet<string> = new Set([
  'slacato',
  'slacato_demo',
  'slacato_openrouter',
  'slacato_e2e'
]);

export const RESET_OVERRIDE_FLAG = '--force-unsafe-database';
export const RESET_OVERRIDE_ENV = 'SLACATO_RESET_CONFIRM_DATABASE';

/** Reads the database name out of a PostgreSQL connection URL. */
export function databaseNameFrom(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
}

/**
 * Reports whether a connection URL names a database this repository created for demos or tests.
 *
 * Both halves matter. A loopback host alone would accept a developer's local copy of something
 * real, and a recognized name alone would accept a remote database that happens to share it.
 */
export function isRecognizedLocalDemoDatabase(databaseUrl: string): boolean {
  const url = new URL(databaseUrl);
  return LOCAL_HOSTS.has(url.hostname) && DEMO_DATABASES.has(databaseNameFrom(databaseUrl));
}

/**
 * Refuses to operate on anything but a local demo database.
 *
 * A reset destroys work, so pointing it at the wrong database is the failure worth preventing. The
 * check is deliberately unforgiving: the host must be loopback and the database name must be one of
 * the known demo names. An operator who genuinely means to target something else must both pass an
 * explicit flag and name that exact database in an environment variable, so no single mistyped
 * `DATABASE_URL` can ever be enough.
 */
export function assertResettableDatabase(
  databaseUrl: string,
  argv: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env
): string {
  const database = databaseNameFrom(databaseUrl);
  if (isRecognizedLocalDemoDatabase(databaseUrl)) return database;
  const overridden =
    argv.includes(RESET_OVERRIDE_FLAG) &&
    environment[RESET_OVERRIDE_ENV] === database &&
    database.length > 0;
  if (overridden) return database;
  throw new Error(
    `Refusing to reset ${database || '(no database)'} on ${new URL(databaseUrl).hostname}: not a recognized local demo database. ` +
      `Expected one of ${[...DEMO_DATABASES].join(', ')} on a loopback host. ` +
      `To override deliberately, pass ${RESET_OVERRIDE_FLAG} and set ${RESET_OVERRIDE_ENV}=${database || '<database>'}.`
  );
}

/** Says whether the running API may expose a sandbox reset, and against which database. */
export type SandboxResetPolicy =
  | Readonly<{ enabled: true; database: string }>
  | Readonly<{ enabled: false; reason: string }>;

/**
 * Resolves whether this process may expose a sandbox reset at all.
 *
 * Two independent variables have to agree, mirroring the CLI's flag-plus-name double lock:
 *
 *   `SLACATO_SANDBOX_RESET=enabled` turns the capability on. It is absent by default, so a build
 *   that nobody configured - including the public deployment - has no reset in it.
 *
 *   The connected database must then also be recognized as a sandbox: either a known demo name on
 *   a loopback host, or a database named exactly by `SLACATO_SANDBOX_RESET_DATABASE`. A hosted
 *   sandbox is reachable only through that second variable, which means enabling the capability
 *   and choosing the database it applies to are two separate, deliberate acts. Setting the flag
 *   and then repointing `DATABASE_URL` disables the reset rather than redirecting it.
 */
export function resolveSandboxResetPolicy(environment: Env): SandboxResetPolicy {
  if (environment.SLACATO_SANDBOX_RESET !== 'enabled')
    return { enabled: false, reason: 'SLACATO_SANDBOX_RESET is not set to "enabled"' };
  let database: string;
  try {
    database = databaseNameFrom(environment.DATABASE_URL);
  } catch {
    return { enabled: false, reason: 'DATABASE_URL is not a parseable connection URL' };
  }
  if (isRecognizedLocalDemoDatabase(environment.DATABASE_URL)) return { enabled: true, database };
  if (
    environment.SLACATO_SANDBOX_RESET_DATABASE !== undefined &&
    environment.SLACATO_SANDBOX_RESET_DATABASE === database &&
    database.length > 0
  )
    return { enabled: true, database };
  return {
    enabled: false,
    reason:
      `database "${database}" is not a recognized sandbox; ` +
      `set SLACATO_SANDBOX_RESET_DATABASE=${database || '<database>'} to designate it`
  };
}
