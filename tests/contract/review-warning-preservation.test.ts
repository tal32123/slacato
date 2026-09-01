import { expect, it } from 'vitest';
import { validateDealBrief } from '@slacato/core';
import {
  contactEvidenceId,
  DEAL_DESK_POLICY_EVIDENCE_ID,
  fixtureEvidence,
  healthyBrief,
  NORTHSTAR_CONTACTS,
  northstarStakeholder
} from '../support/brief-fixtures.js';

it('preserves distinct evidence warnings while suppressing stale supported identity warnings', () => {
  const generated = healthyBrief();
  const amara = NORTHSTAR_CONTACTS[4];
  const policyWarning = {
    code: 'MISSING_MATERIAL_EVIDENCE',
    severity: 'critical' as const,
    message: 'No evidence shows Amara Quinn approved the discount',
    claimIds: []
  };
  const claimSupportWarning = {
    code: 'INSUFFICIENT_CLAIM_SUPPORT',
    severity: 'warning' as const,
    message: 'No evidence shows Amara Quinn approved the discount',
    claimIds: []
  };
  const staleIdentityWarning = {
    code: 'INSUFFICIENT_CLAIM_SUPPORT',
    severity: 'warning' as const,
    message: `Material anchors are absent: ${amara.title.toLocaleLowerCase('en-US')} ${amara.name.toLocaleLowerCase('en-US')}`,
    claimIds: []
  };
  const evidence = [
    fixtureEvidence(contactEvidenceId(NORTHSTAR_CONTACTS[1].contactId)),
    fixtureEvidence(contactEvidenceId(amara.contactId)),
    fixtureEvidence('slack:SLK-9002:0'),
    fixtureEvidence(DEAL_DESK_POLICY_EVIDENCE_ID)
  ];

  const brief = validateDealBrief(
    {
      ...generated,
      stakeholderMap: {
        stakeholders: [...generated.stakeholderMap.stakeholders, northstarStakeholder(amara)]
      },
      confidenceAndReviewWarnings: {
        ...generated.confidenceAndReviewWarnings,
        warnings: [policyWarning, claimSupportWarning, staleIdentityWarning]
      }
    },
    evidence,
    {
      account: { id: 'ACC-2001', name: 'Northstar Foods Cooperative' },
      opportunity: {
        id: 'OPP-1001',
        name: 'Northstar Foods Cooperative - Global Access Renewal',
        stage: '6.0 Order Review'
      }
    }
  );

  expect(brief.confidenceAndReviewWarnings.warnings).toContainEqual(policyWarning);
  expect(brief.confidenceAndReviewWarnings.warnings).toContainEqual(claimSupportWarning);
  expect(brief.confidenceAndReviewWarnings.warnings).not.toContainEqual(staleIdentityWarning);
});
