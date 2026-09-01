import { describe, expect, it } from 'vitest';
import type { DealBrief } from '@slacato/core';
import {
  type BriefQualityRule,
  collectUserFacingProse,
  evaluateBriefQuality,
  expectationsForOpportunity,
  supportedStakeholderNames
} from '../../scripts/brief-quality.js';
import {
  contactEvidenceId,
  fixtureCitation,
  fixtureClaim,
  healthyBrief,
  NORTHSTAR_CONTACTS,
  NORTHSTAR_EXPECTATIONS,
  northstarStakeholder
} from '../support/brief-fixtures.js';

function rules(brief: DealBrief): readonly BriefQualityRule[] {
  return evaluateBriefQuality(brief, NORTHSTAR_EXPECTATIONS).violations.map(
    (violation) => violation.rule
  );
}

describe('brief-quality invariants', () => {
  it('passes a brief that surfaces its stakeholders, cites two source families, and warns cleanly', () => {
    expect(evaluateBriefQuality(healthyBrief(), NORTHSTAR_EXPECTATIONS)).toMatchObject({
      violations: [],
      sourceTypes: ['crm', 'policy', 'slack'],
      stakeholderNames: ['Marco Devlin']
    });
  });

  it('flags a stakeholder dropped from the map while its contact record still reaches Source Evidence', () => {
    const brief = healthyBrief();
    const dropped = {
      ...brief,
      stakeholderMap: { stakeholders: [] },
      sourceEvidence: brief.sourceEvidence
    } as DealBrief;
    expect(rules(dropped)).toContain('silently-discarded-stakeholder');
  });

  it('flags the validator discard markers that only appear after content was deleted', () => {
    const withGap = {
      ...healthyBrief(),
      stakeholderMap: {
        ...healthyBrief().stakeholderMap,
        coverageGaps: ['Verify unsupported stakeholder records.']
      }
    } as DealBrief;
    expect(rules(withGap)).toContain('discarded-content-marker');
    const withItem = {
      ...healthyBrief(),
      missingInformation: {
        items: [
          {
            question: 'Verify unsupported generated assertions before use.',
            whyItMatters: 'The generated assertion lacks support in the authorized manifest.'
          }
        ]
      }
    } as DealBrief;
    expect(rules(withItem)).toContain('discarded-content-marker');
  });

  it('flags a finalized brief whose citations never leave one source family', () => {
    const brief = healthyBrief();
    const crmOnly = {
      ...brief,
      sourceEvidence: { evidence: [brief.sourceEvidence.evidence[0]] }
    } as DealBrief;
    const report = evaluateBriefQuality(crmOnly, NORTHSTAR_EXPECTATIONS);
    expect(report.sourceTypes).toEqual(['crm']);
    expect(report.violations.filter((violation) => violation.rule === 'multi-source-citations'))
      .toHaveLength(2);
  });

  it('flags every required section that a finalized brief left empty', () => {
    const empty = {
      ...healthyBrief(),
      stakeholderMap: { stakeholders: [] },
      recommendedNextActions: { actions: [] },
      negotiationState: { ...healthyBrief().negotiationState, risks: [] },
      sourceEvidence: { evidence: [] }
    } as DealBrief;
    const report = evaluateBriefQuality(empty, NORTHSTAR_EXPECTATIONS);
    expect(report.sections).toEqual({
      stakeholderMap: 0,
      recommendedNextActions: 0,
      negotiationRisks: 0,
      sourceEvidence: 0
    });
    expect(
      report.violations.filter((violation) => violation.rule === 'required-sections-populated')
    ).toHaveLength(4);
  });

  it('flags internal identifiers in copy while leaving structured citation payloads alone', () => {
    const brief = healthyBrief();
    const leaked = {
      ...brief,
      missingInformation: {
        items: [
          {
            question: 'Verify evidence for claim claim_stk_elena.',
            whyItMatters: 'No single cited evidence unit supports the complete material relation.'
          }
        ]
      }
    } as DealBrief;
    expect(rules(leaked)).toContain('internal-identifier-in-copy');
    // The control brief carries the same identifiers structurally and must stay clean.
    expect(rules(brief)).not.toContain('internal-identifier-in-copy');
    expect(collectUserFacingProse(brief).map((field) => field.path)).not.toContain(
      'sourceEvidence.evidence[0].evidenceId'
    );
  });

  it('flags a warning that reports a stakeholder as absent while the brief presents them', () => {
    const brief = healthyBrief();
    const contradicting = {
      ...brief,
      confidenceAndReviewWarnings: {
        overallConfidence: 0.9,
        warnings: [
          {
            code: 'INSUFFICIENT_CLAIM_SUPPORT',
            severity: 'warning',
            message: 'Material anchors are absent: legal counsel amara quinn',
            claimIds: []
          }
        ]
      },
      stakeholderMap: { stakeholders: [northstarStakeholder(NORTHSTAR_CONTACTS[4])] }
    } as DealBrief;
    expect(supportedStakeholderNames(contradicting)).toEqual(['Amara Quinn']);
    expect(rules(contradicting)).toContain('self-contradictory-warning');
  });

  it('does not flag a warning that names a stakeholder without claiming they are absent', () => {
    const brief = healthyBrief();
    const benign = {
      ...brief,
      confidenceAndReviewWarnings: {
        overallConfidence: 0.9,
        warnings: [
          {
            code: 'POLICY_LEGAL_APPROVAL',
            severity: 'warning',
            message: 'Legal review by Marco Devlin is required before the terms are shared.',
            claimIds: []
          }
        ]
      }
    } as DealBrief;
    expect(rules(benign)).not.toContain('self-contradictory-warning');
  });

  it('flags a brief that states the deal commercial position with no pricing or policy evidence', () => {
    const brief = healthyBrief();
    const unprovenanced = {
      ...brief,
      sourceEvidence: {
        evidence: brief.sourceEvidence.evidence.filter(
          (entry) => entry.sourceType !== 'pricing' && entry.sourceType !== 'policy'
        )
      },
      negotiationState: {
        ...brief.negotiationState,
        claims: brief.negotiationState.claims.map((claim) => ({
          ...claim,
          citations: [fixtureCitation(contactEvidenceId('CON-3002'))]
        }))
      }
    } as DealBrief;
    expect(rules(unprovenanced)).toContain('commercial-claim-provenance');
  });

  it('flags a stated discount that cites a contact record instead of pricing or policy evidence', () => {
    const brief = healthyBrief();
    const fabricatedDiscount = {
      ...brief,
      negotiationState: {
        ...brief.negotiationState,
        claims: [
          ...brief.negotiationState.claims,
          fixtureClaim(
            'claim_ns_discount',
            'Procurement secured a 15 percent discount on the renewal.',
            contactEvidenceId('CON-3002')
          )
        ]
      }
    } as DealBrief;
    expect(rules(fabricatedDiscount)).toContain('commercial-claim-provenance');
  });

  it('does not demand pricing provenance from a brief that states no commercial position', () => {
    const brief = healthyBrief();
    const operational = {
      ...brief,
      sourceEvidence: {
        evidence: brief.sourceEvidence.evidence.filter(
          (entry) => entry.sourceType !== 'pricing' && entry.sourceType !== 'policy'
        )
      },
      negotiationState: {
        currentState: 'The rollout model is under review with the account team.',
        leverage: [],
        risks: ['Regional exception handling remains unresolved.'],
        claims: [
          fixtureClaim(
            'claim_ns_1',
            'The rollout model is under review with the account team.',
            contactEvidenceId('CON-3002')
          )
        ]
      }
    } as DealBrief;
    expect(rules(operational)).not.toContain('commercial-claim-provenance');
  });

  it('derives its expectations from the canonical fixtures rather than a hand-kept list', () => {
    const expectations = expectationsForOpportunity('fixtures/cato', 'OPP-1001');
    expect(expectations.contactsByEvidenceId[contactEvidenceId('CON-3001')]).toBe('Elena Voss');
    expect(Object.keys(expectations.contactsByEvidenceId)).toHaveLength(5);
    expect(expectations.reachableSourceTypes).toEqual(['crm', 'conversation', 'slack']);
  });
});
