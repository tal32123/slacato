import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

export type SlacatoDatabase = PostgresJsDatabase<typeof schema>;

/** Owns a bounded PostgreSQL connection pool and its Drizzle query facade. */
export type DatabaseClient = Readonly<{ sql: Sql; db: SlacatoDatabase; close: () => Promise<void> }>;

export function createDatabaseClient(databaseUrl: string, maxConnections = 10): DatabaseClient {
  const sql = postgres(databaseUrl, { max: maxConnections, idle_timeout: 20, connect_timeout: 5 });
  return { sql, db: drizzle({ client: sql, schema }), close: () => sql.end({ timeout: 5 }) };
}
