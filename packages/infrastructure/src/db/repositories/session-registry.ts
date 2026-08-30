import type { DatabaseClient } from '../client.js';

/** Server-authoritative session lifecycle shared by every API replica. */
export class PostgresSessionRegistry {
  /** Creates a session registry backed by the provided database client. */
  public constructor(private readonly database: DatabaseClient) {}

  /** Persists a new active session for the authenticated user. */
  public async activate(
    input: Readonly<{ version: string; userId: string; expiresAt: Date }>
  ): Promise<void> {
    await this.database.sql`insert into auth_sessions (version, persona_id, expires_at)
      values (${input.version}, ${input.userId}, ${input.expiresAt.toISOString()}::timestamptz)`;
  }

  /** Marks the identified session as revoked without changing its original revocation time. */
  public async revoke(version: string): Promise<void> {
    await this.database
      .sql`update auth_sessions set revoked_at = coalesce(revoked_at, now()) where version = ${version}`;
  }

  /** Reports whether the identified user session exists, remains unrevoked, and has not expired. */
  public async isActive(version: string, userId: string): Promise<boolean> {
    const row = (
      await this.database.sql<{ active: boolean }[]>`select exists (
      select 1 from auth_sessions where version = ${version}::uuid and persona_id = ${userId}
        and revoked_at is null and expires_at > now()
    ) active`
    )[0];
    return row?.active === true;
  }
}
