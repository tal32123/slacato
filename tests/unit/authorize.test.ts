import { describe, expect, it } from 'vitest';
import { authorizeOpportunity, deriveApprovalAuthority, type AuthorizationSession } from '@slacato/core';

const restrictedOpportunity = { accountId: 'ACC-2003', restricted: true } as const;

const harperSession: AuthorizationSession = {
  userId: 'USR-5007',
  grants: [{
    accountId: 'ACC-2001',
    sourceType: 'salesforce',
    canRead: true,
    canReadRestricted: false,
    canRequestApproval: false,
    canApprove: false,
    sensitivePricing: false
  }]
};

describe('authorizeOpportunity', () => {
  it('denies a persona outside the account scope without disclosing target metadata', () => {
    const result = authorizeOpportunity(harperSession, restrictedOpportunity);

    expect(result).toEqual({ allowed: false, reason: 'forbidden' });
    expect(JSON.stringify(result)).not.toContain('ACC-2003');
  });

  it('fails closed when a matching grant cannot read restricted accounts', () => {
    const result = authorizeOpportunity({
      userId: 'USR-5007',
      grants: [{ ...harperSession.grants[0]!, accountId: 'ACC-2003' }]
    }, restrictedOpportunity);

    expect(result).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('returns only the effective target scope from canonical readable grants', () => {
    const result = authorizeOpportunity({
      userId: 'USR-5005',
      grants: [
        { accountId: 'ACC-2001', sourceType: 'slack', canRead: true, canReadRestricted: false, canRequestApproval: true, canApprove: true, sensitivePricing: false },
        { accountId: 'ACC-2003', sourceType: 'salesforce', canRead: true, canReadRestricted: true, canRequestApproval: true, canApprove: true, sensitivePricing: true },
        { accountId: 'ACC-2003', sourceType: 'pricing', canRead: true, canReadRestricted: true, canRequestApproval: true, canApprove: true, sensitivePricing: true },
        { accountId: 'ACC-2003', sourceType: 'gong_summary', canRead: false, canReadRestricted: true, canRequestApproval: true, canApprove: true, sensitivePricing: true }
      ]
    }, restrictedOpportunity);

    expect(result).toEqual({
      allowed: true,
      accountIds: ['ACC-2003'],
      sourceTypes: ['pricing', 'salesforce'],
      canViewSensitivePricing: true,
      canRequestApproval: true,
      canApprove: true,
      canViewRestrictedAccounts: true
    });
  });

  it('filters every source grant individually for a restricted opportunity', () => {
    const result = authorizeOpportunity({ userId: 'USR-5003', grants: [
      { accountId: 'ACC-2003', sourceType: 'salesforce', canRead: true, canReadRestricted: true, canRequestApproval: true, canApprove: false, sensitivePricing: true },
      { accountId: 'ACC-2003', sourceType: 'slack', canRead: true, canReadRestricted: false, canRequestApproval: true, canApprove: true, sensitivePricing: true },
      { accountId: 'ACC-2003', sourceType: 'pricing', canRead: true, canReadRestricted: true, canRequestApproval: true, canApprove: false, sensitivePricing: false }
    ] }, restrictedOpportunity);

    expect(result).toEqual({
      allowed: true,
      accountIds: ['ACC-2003'],
      sourceTypes: ['pricing', 'salesforce'],
      canViewSensitivePricing: false,
      canRequestApproval: true,
      canApprove: false,
      canViewRestrictedAccounts: true
    });
  });
});

describe('deriveApprovalAuthority', () => {
  const policy = 'Discounts require Deal Desk approval. Discounts over 15 percent require sales leader approval.';

  it('never turns an account owner request permission into approval authority', () => {
    expect(deriveApprovalAuthority('Account Owner', policy)).toBe(false);
    expect(deriveApprovalAuthority('Restricted Account Owner', policy)).toBe(false);
  });

  it('recognizes only canonical approver roles documented by policy', () => {
    expect(deriveApprovalAuthority('Deal Desk Approver', policy)).toBe(true);
    expect(deriveApprovalAuthority('Sales Leader', policy)).toBe(true);
    expect(deriveApprovalAuthority('Sales Leader', 'Only Deal Desk approval is permitted.')).toBe(false);
    expect(deriveApprovalAuthority('Administrator', policy)).toBe(false);
  });
});
