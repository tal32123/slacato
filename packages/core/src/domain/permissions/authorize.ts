import type { ApprovalAuthority } from '../briefs/policy.js';
export const AUTHORIZED_SOURCE_TYPES = [
  'gong_summary',
  'gong_transcript',
  'policy',
  'pricing',
  'salesforce',
  'slack'
] as const;
export type AuthorizedSourceType = (typeof AUTHORIZED_SOURCE_TYPES)[number];

export type PermissionGrant = Readonly<{
  accountId: string;
  sourceType: AuthorizedSourceType;
  canRead: boolean;
  canReadRestricted: boolean;
  canRequestApproval: boolean;
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
      canRequestApproval: boolean;
      canApprove: boolean;
      canViewRestrictedAccounts: boolean;
    }>;

/** Derives the smallest readable scope for one target and fails closed without target metadata. */
export function authorizeOpportunity(
  session: AuthorizationSession,
  opportunity: OpportunityAuthorizationTarget
): AccessScope {
  const readable = session.grants.filter(
    (grant) =>
      grant.accountId === opportunity.accountId &&
      grant.canRead &&
      (!opportunity.restricted || grant.canReadRestricted)
  );
  if (readable.length === 0) {
    return { allowed: false, reason: 'forbidden' };
  }

  return {
    allowed: true,
    accountIds: [opportunity.accountId],
    sourceTypes: [...new Set(readable.map((grant) => grant.sourceType))].sort(),
    canViewSensitivePricing: readable.some(
      (grant) => grant.sourceType === 'pricing' && grant.sensitivePricing
    ),
    canRequestApproval: readable.some((grant) => grant.canRequestApproval),
    canApprove: readable.some((grant) => grant.canApprove),
    canViewRestrictedAccounts: readable.some((grant) => grant.canReadRestricted)
  };
}

/** Maps a persona role to explicit authorities; request permission is deliberately not an input. */
export function deriveApprovalAuthorities(
  role: string,
  policyContent: string
): readonly ApprovalAuthority[] {
  if (role === 'Deal Desk Approver') return ['deal_desk'];
  if (role === 'Legal Reviewer') return ['legal_reviewer'];
  if (role === 'Account Owner' || role === 'Restricted Account Owner') return ['account_owner'];
  if (
    (role === 'Sales Leader' || role === 'Restricted Sales Leader') &&
    /sales leader approval/i.test(policyContent)
  )
    return ['sales_leader'];
  return [];
}

/** Maps canonical roles to least-privilege decision authority without conflating request permission. */
export function deriveApprovalAuthority(role: string, policyContent: string): boolean {
  return deriveApprovalAuthorities(role, policyContent).length > 0;
}
