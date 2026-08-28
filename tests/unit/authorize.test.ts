import { describe, expect, it } from 'vitest';
import { authorizeOpportunity, type AuthorizationSession } from '@slacato/core';

const restrictedOpportunity = { accountId: 'ACC-2003', restricted: true } as const;

const harperSession: AuthorizationSession = {
  userId: 'USR-5007',
  grants: [{
    accountId: 'ACC-2001',
    sourceType: 'salesforce',
    canRead: true,
    canReadRestricted: false,
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
        { accountId: 'ACC-2001', sourceType: 'slack', canRead: true, canReadRestricted: false, canApprove: true, sensitivePricing: false },
        { accountId: 'ACC-2003', sourceType: 'salesforce', canRead: true, canReadRestricted: true, canApprove: true, sensitivePricing: true },
        { accountId: 'ACC-2003', sourceType: 'pricing', canRead: true, canReadRestricted: true, canApprove: true, sensitivePricing: true },
        { accountId: 'ACC-2003', sourceType: 'gong_summary', canRead: false, canReadRestricted: true, canApprove: true, sensitivePricing: true }
      ]
    }, restrictedOpportunity);

    expect(result).toEqual({
      allowed: true,
      accountIds: ['ACC-2003'],
      sourceTypes: ['pricing', 'salesforce'],
      canViewSensitivePricing: true,
      canApprove: true,
      canViewRestrictedAccounts: true
    });
  });
});
