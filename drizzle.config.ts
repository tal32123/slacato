import { defineConfig } from 'drizzle-kit';

// drizzle-kit does not load .env itself. Load it here so `pnpm db:generate` /
// `pnpm db:migrate` target the same database as the app and test suite. In CI
// (or anywhere real environment variables are already set) there is no .env
// file to find, and process.loadEnvFile never overwrites a variable that is
// already present in process.env, so this is safe in both places.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file present — rely on the environment (CI, containers, etc).
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Create a .env file (see .env.example) or export ' +
      'DATABASE_URL before running drizzle-kit. Refusing to fall back to a guessed ' +
      'connection string: a wrong-but-plausible default is what silently pointed ' +
      'past runs at the stale `slacato` database instead of `slacato_openrouter`.'
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/infrastructure/src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: databaseUrl
  },
  strict: true,
  verbose: true
});
