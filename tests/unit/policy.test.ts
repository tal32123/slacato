import { describe, expect, it } from 'vitest';
import {
  DEMO_APPROVAL_IDENTITIES,
  dealBriefSchema,
  decideApprovalRequirement,
  extractEditedPolicySignals,
  hashApprovalPayload,
  validateDealBrief,
  type ApprovalRequirementInput
} from '@slacato/core';
const safe: ApprovalRequirementInput = {
  discountPercent: 10,
  renewalUpliftPercent: 0,
  liabilityCapChanged: false,
  dataRetentionLanguage: false,
  restrictedResearchLanguage: false,
  customerSpecificSecurityLanguage: false,
  customerFacingConcessionLanguage: false,
  overallConfidence: 0.7,
  conflictingEvidence: false,
  missingMaterialEvidence: false
};

function entries(input: Partial<ApprovalRequirementInput>) {
  return decideApprovalRequirement({ ...safe, ...input }).entries.map(({ category, eligibleAuthorities, dependsOn }) => ({
    category,
    eligibleAuthorities,
    dependsOn
  }));
}

function editedBrief(narrative: string) {
  return dealBriefSchema.parse({
    dealSnapshot: { accountName: 'Account', opportunityName: 'Opportunity', stage: 'Negotiate' },
    executiveSummary: { narrative },
    buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
    stakeholderMap: { stakeholders: [] },
    negotiationState: { currentState: 'Insufficient supported evidence is available.', risks: [] },
    recommendedNextActions: { actions: [] },
    missingInformation: { items: [] },
    sourceEvidence: { evidence: [] },
    confidenceAndReviewWarnings: { overallConfidence: 0.9, warnings: [] }
  });
}

describe('deterministic brief approval policy', () => {
  it('does not gate exact discount and confidence boundaries', () => {
    expect(entries({ discountPercent: 10, overallConfidence: 0.7 })).toEqual([]);
  });

  it('requires Deal Desk above 10% and for negative renewal uplift', () => {
    expect(entries({ discountPercent: 10.01 })).toEqual([{
      category: 'commercial_discount', eligibleAuthorities: ['deal_desk'], dependsOn: []
    }]);
    expect(entries({ renewalUpliftPercent: -0.01 })).toEqual([{
      category: 'commercial_discount', eligibleAuthorities: ['deal_desk'], dependsOn: []
    }]);
  });

  it('requires a distinct Deal Desk and Sales Leader quorum above 15%', () => {
    expect(entries({ discountPercent: 18 })).toEqual([
      { category: 'commercial_discount', eligibleAuthorities: ['deal_desk'], dependsOn: [] },
      { category: 'commercial_discount', eligibleAuthorities: ['sales_leader'], dependsOn: [] }
    ]);
  });

  it.each([
    ['liability-cap changes', { liabilityCapChanged: true }],
    ['data-retention language', { dataRetentionLanguage: true }],
    ['restricted-research language', { restrictedResearchLanguage: true }],
    ['customer-specific-security language', { customerSpecificSecurityLanguage: true }]
  ] as const)('requires Legal Reviewer authority for %s', (_name, input) => {
    expect(entries(input)).toEqual([{
      category: 'legal_terms', eligibleAuthorities: ['legal_reviewer'], dependsOn: []
    }]);
  });

  it.each([
    ['low confidence', { overallConfidence: 0.699 }],
    ['conflicting evidence', { conflictingEvidence: true }],
    ['missing material evidence', { missingMaterialEvidence: true }]
  ] as const)('requires scoped human review for %s', (_name, input) => {
    expect(entries(input)).toEqual([{
      category: 'evidence_review', eligibleAuthorities: ['account_owner', 'sales_leader'], dependsOn: []
    }]);
  });

  it('places account-owner confirmation after every underlying approval entry', () => {
    const requirement = decideApprovalRequirement({
      ...safe,
      discountPercent: 18,
      liabilityCapChanged: true,
      customerFacingConcessionLanguage: true
    });
    const confirmation = requirement.entries.at(-1);
    expect(confirmation?.category).toBe('customer_concession');
    expect(confirmation?.eligibleAuthorities).toEqual(['account_owner']);
    expect(confirmation?.dependsOn).toEqual(requirement.entries.slice(0, -1).map((entry) => entry.id));
    expect(new Set(requirement.entries.map((entry) => entry.id)).size).toBe(requirement.entries.length);
    expect(requirement.quorumVersion).toBe('deal-brief-approval-v1');
  });

  it.each([
    ['we will accept broader exposure', { liabilityCapChanged: true, customerFacingConcessionLanguage: false }],
    ['we can offer a reduction', { liabilityCapChanged: false, customerFacingConcessionLanguage: true }]
  ] as const)('semantically gates adversarial edited wording: %s', (narrative, expected) => {
    expect(extractEditedPolicySignals(editedBrief(narrative))).toMatchObject(expected);
  });

  it('changes unsupported free narrative under the production claim-support validator', () => {
    const edited = editedBrief('we can offer a reduction');
    const grounded = validateDealBrief(edited, [], {
      account: { id: 'ACC-1', name: 'Account' },
      opportunity: { id: 'OPP-1', name: 'Opportunity', stage: 'Negotiate' }
    });
    expect(hashApprovalPayload(grounded)).not.toBe(hashApprovalPayload(edited));
    expect(grounded.executiveSummary.narrative).toContain('Insufficient supported evidence');
  });

  it('checks in demo-only Legal Reviewer and restricted Sales Leader identities without retrieval access', () => {
    expect(DEMO_APPROVAL_IDENTITIES).toEqual([
      {
        userId: 'USR-5006', displayName: 'Iris Wynn', role: 'Legal Reviewer', accountId: 'ACC-2003',
        authorities: ['legal_reviewer'], demoOnly: true, evidenceRetrieval: false
      },
      {
        userId: 'USR-5008', displayName: 'Tomas Reed', role: 'Restricted Sales Leader', accountId: 'ACC-2003',
        authorities: ['sales_leader'], demoOnly: true, evidenceRetrieval: false
      }
    ]);
  });
});
