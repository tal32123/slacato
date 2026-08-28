import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/infrastructure/src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato'
  },
  strict: true,
  verbose: true
});
