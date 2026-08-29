import type { AccountApprovalAuthorityView } from '@slacato/contracts';
import { CANONICAL_FIXTURE_COMMIT } from '@slacato/core';
import type { DatabaseClient } from '../client.js';

/** Reads canonical account approval authorities from PostgreSQL without consulting evidence permissions. */
export class PostgresApprovalAuthorityQuery {
  /** Creates an approval-authority query backed by the supplied database client. */
  public constructor(private readonly database: DatabaseClient) {}

  /** Returns the account-scoped authorities granted to one canonical persona. */
  public async forPersona(personaId: string): Promise<readonly AccountApprovalAuthorityView[]> {
    return this.database.sql<AccountApprovalAuthorityView[]>`
      select account_id "accountId", array_agg(authority order by authority)::text[] authorities
      from approval_authority_grants
      where persona_id = ${personaId} and source_commit = ${CANONICAL_FIXTURE_COMMIT}
      group by account_id
      order by account_id
    `;
  }
}
