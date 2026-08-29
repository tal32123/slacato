import {
  AUTHORIZED_SOURCE_TYPES,
  type AuthorizedSourceType,
  CANONICAL_FIXTURE_COMMIT,
  type PermissionGrant
} from '@slacato/core';
import type { DatabaseClient } from '../client.js';

type PersonaRow = Readonly<{ id: string; display_name: string; role: string }>;
type GrantRow = Readonly<{
  account_id: string | null;
  source_type: string | null;
  can_read: boolean;
  can_read_restricted: boolean;
  can_request_approval: boolean;
  can_approve: boolean;
  sensitive_pricing: boolean;
}>;

export type IngestedPersona = Readonly<{
  userId: string;
  displayName: string;
  role: string;
  grants: readonly PermissionGrant[];
}>;

const knownSources = new Set<string>(AUTHORIZED_SOURCE_TYPES);

/** Reads identities and grants only from canonical records already persisted by ingestion. */
export class PostgresCanonicalPersonaDirectory {
  /** Retains the database client used to read canonical persona records and close the connection. */
  public constructor(private readonly client: DatabaseClient) {}

  /** Lists every persona from the canonical fixture together with its permission grants. */
  public async list(): Promise<readonly IngestedPersona[]> {
    const rows = await this.client.sql<PersonaRow[]>`
      select id, display_name, role from personas
      where source_commit = ${CANONICAL_FIXTURE_COMMIT}
      order by display_name, id
    `;
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  /** Finds a canonical persona by user identifier and includes its permission grants when present. */
  public async findById(userId: string): Promise<IngestedPersona | undefined> {
    const rows = await this.client.sql<PersonaRow[]>`
      select id, display_name, role from personas
      where id = ${userId} and source_commit = ${CANONICAL_FIXTURE_COMMIT}
      limit 1
    `;
    const row = rows[0];
    return row === undefined ? undefined : this.hydrate(row);
  }

  /** Closes the database client when the application shuts down. */
  public async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }

  /** Hydrates a persisted persona row with its validated canonical permission grants. */
  private async hydrate(persona: PersonaRow): Promise<IngestedPersona> {
    const rows = await this.client.sql<GrantRow[]>`
      select account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing
      from permission_grants where persona_id = ${persona.id} and source_commit = ${CANONICAL_FIXTURE_COMMIT}
      order by account_id, source_type, id
    `;
    const grants = rows.map((row): PermissionGrant => {
      if (
        row.account_id === null ||
        row.source_type === null ||
        !knownSources.has(row.source_type)
      ) {
        throw new Error(`Invalid canonical grant for persona ${persona.id}`);
      }
      return {
        accountId: row.account_id,
        sourceType: row.source_type as AuthorizedSourceType,
        canRead: row.can_read,
        canReadRestricted: row.can_read_restricted,
        canRequestApproval: row.can_request_approval,
        canApprove: row.can_approve,
        sensitivePricing: row.sensitive_pricing
      };
    });
    return { userId: persona.id, displayName: persona.display_name, role: persona.role, grants };
  }
}
