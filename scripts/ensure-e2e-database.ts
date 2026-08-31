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
 */
async function main(): Promise<void> {
  const targetUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato_e2e';
  const parsed = new URL(targetUrl);
  const databaseName = parsed.pathname.replace(/^\//, '');
  if (databaseName.length === 0) throw new Error(`DATABASE_URL is missing a database name: ${targetUrl}`);

  const adminUrl = new URL(parsed);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${databaseName}`;
    if (existing.length > 0) {
      console.log(`[ensure-e2e-database] "${databaseName}" already exists`);
      return;
    }
    // Database names cannot be parameterized; databaseName is validated as a plain Postgres
    // identifier below to keep this safe against anything other than a deliberately malformed
    // DATABASE_URL.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(databaseName))
      throw new Error(`Refusing to create a database with an unexpected name: ${databaseName}`);
    await admin.unsafe(`create database ${databaseName}`);
    console.log(`[ensure-e2e-database] created "${databaseName}"`);
  } finally {
    await admin.end({ timeout: 1 });
  }
}

await main();
