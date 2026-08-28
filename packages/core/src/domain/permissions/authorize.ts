export const AUTHORIZED_SOURCE_TYPES = ['gong_summary', 'gong_transcript', 'policy', 'pricing', 'salesforce', 'slack'] as const;
export type AuthorizedSourceType = typeof AUTHORIZED_SOURCE_TYPES[number];

export type PermissionGrant = Readonly<{
  accountId: string;
  sourceType: AuthorizedSourceType;
  canRead: boolean;
  canReadRestricted: boolean;
  canApprove: boolean;
  sensitivePricing: boolean;
}>;

export type AuthorizationSession = Readonly<{
  userId: string;
  grants: readonly PermissionGrant[];
}>;

export type OpportunityAuthorizationTarget = Readonly<{
  accountId: string;
  restricted: boolean;
}>;

export type AccessScope =
  | Readonly<{ allowed: false; reason: 'forbidden' }>
  | Readonly<{
      allowed: true;
      accountIds: readonly string[];
      sourceTypes: readonly AuthorizedSourceType[];
      canViewSensitivePricing: boolean;
      canApprove: boolean;
      canViewRestrictedAccounts: boolean;
    }>;

/** Derives the smallest readable scope for one target and fails closed without target metadata. */
export function authorizeOpportunity(
  session: AuthorizationSession,
  opportunity: OpportunityAuthorizationTarget
): AccessScope {
  const readable = session.grants.filter((grant) => grant.accountId === opportunity.accountId && grant.canRead);
  if (readable.length === 0 || (opportunity.restricted && !readable.some((grant) => grant.canReadRestricted))) {
    return { allowed: false, reason: 'forbidden' };
  }

  return {
    allowed: true,
    accountIds: [opportunity.accountId],
    sourceTypes: [...new Set(readable.map((grant) => grant.sourceType))].sort(),
    canViewSensitivePricing: readable.some((grant) => grant.sensitivePricing),
    canApprove: readable.some((grant) => grant.canApprove),
    canViewRestrictedAccounts: readable.some((grant) => grant.canReadRestricted)
  };
}
