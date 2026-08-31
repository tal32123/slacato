import postgres from 'postgres';

/**
 * Creates the target database named in DATABASE_URL if it does not already exist.
 *
 * Why this exists: playwright.config.ts's e2e suite used to default DATABASE_URL to
 * postgres://slacato:slacato@127.0.0.1:54329/slacato -- the exact same connection string shipped
 * in .env.example for local manual `pnpm dev` use, and the exact database docker-compose.yml
 * provisions with a persistent named volume. Every local e2e run therefore wrote long-lived
 * fixture rows (many of them permanently undeletable -- see approval_requirement_entries'
 * immutability trigger) straight into the same database a developer's local demo/review session
 * reads from. The e2e default now points at a distinct `slacato_e2e` database instead; this
 * script provisions it on first use so a fresh clone does not need a manual `createdb` step.
 * `drizzle-kit migrate` does not create databases, only run migrations inside one that exists.
 *
 * This tries the TARGET database first and only opens an admin connection to the `postgres`
 * database as a fallback when that fails. CI (.github/workflows/ci.yml) sets DATABASE_URL
 * explicitly to its own ephemeral per-job Postgres service, where the database always already
 * exists -- an unconditional admin-first connection would add an extra, non-target connection to
 * every CI run for no reason, and any failure of that connection (auth scope, image variant,
 * timing) would kill the whole `db:ensure && db:migrate && ... && node apps/api/dist/main.js`
 * chain with an error unrelated to its actual cause, on a workflow file this script cannot fix.
 */
async function main(): Promise<void> {
  const targetUrl =
    process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato_e2e';

  const target = postgres(targetUrl, { max: 1 });
  try {
    await target`select 1`;
    console.log('[ensure-e2e-database] target database is already reachable');
    return;
  } catch {
    // Falls through to the create-database path below.
  } finally {
    await target.end({ timeout: 1 });
  }

  const parsed = new URL(targetUrl);
  const databaseName = parsed.pathname.replace(/^\//, '');
  if (databaseName.length === 0)
    throw new Error(`DATABASE_URL is missing a database name: ${targetUrl}`);
  // Database names cannot be parameterized; databaseName is validated as a plain Postgres
  // identifier below to keep this safe against anything other than a deliberately malformed
  // DATABASE_URL.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(databaseName))
    throw new Error(`Refusing to create a database with an unexpected name: ${databaseName}`);

  const adminUrl = new URL(parsed);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${databaseName}`;
    if (existing.length > 0) {
      console.log(
        `[ensure-e2e-database] "${databaseName}" already exists but was not reachable directly`
      );
      return;
    }
    await admin.unsafe(`create database ${databaseName}`);
    console.log(`[ensure-e2e-database] created "${databaseName}"`);
  } finally {
    await admin.end({ timeout: 1 });
  }
}

await main();
