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
  DEAL_DESK_POLICY_EVIDENCE_ID,
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

const GONG_EVIDENCE_ID = 'gong_summary:CALL-001:summary:0';
const PRICING_EVIDENCE_ID = 'pricing:PN-4001:0';
const LEGAL_PRICING_EVIDENCE_ID = 'pricing:PN-4002:0';

function evidenceEntry(
  evidenceId: string,
  sourceType: DealBrief['sourceEvidence']['evidence'][number]['sourceType'],
  summary: string,
  claimId: string
): DealBrief['sourceEvidence']['evidence'][number] {
  return {
    evidenceId,
    sourceType,
    summary,
    capturedAt: '2026-04-18T00:00:00Z',
    claims: [fixtureClaim(claimId, summary, evidenceId)]
  };
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
    const statement = 'The commercial terms are approved for signature.';
    const unprovenanced = {
      ...brief,
      sourceEvidence: {
        evidence: brief.sourceEvidence.evidence.filter(
          (entry) => entry.sourceType !== 'pricing' && entry.sourceType !== 'policy'
        )
      },
      negotiationState: {
        ...brief.negotiationState,
        currentState: statement,
        claims: [
          fixtureClaim(
            'claim_ns_unprovenanced_terms',
            statement,
            contactEvidenceId('CON-3002')
          )
        ]
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

  it.each([
    {
      citedSource: 'CRM',
      citedEvidenceId: contactEvidenceId('CON-3002'),
      citedEvidence: undefined,
      unrelatedEvidence: evidenceEntry(
        DEAL_DESK_POLICY_EVIDENCE_ID,
        'policy',
        'Discounts greater than 10 percent require Deal Desk approval.',
        'claim_ev_unrelated_policy'
      )
    },
    {
      citedSource: 'Gong',
      citedEvidenceId: GONG_EVIDENCE_ID,
      citedEvidence: evidenceEntry(
        GONG_EVIDENCE_ID,
        'conversation',
        'The buyer asked the account team to prepare the final paperwork.',
        'claim_ev_gong'
      ),
      unrelatedEvidence: evidenceEntry(
        PRICING_EVIDENCE_ID,
        'pricing',
        'Customer accepted the renewal uplift range.',
        'claim_ev_unrelated_pricing'
      )
    }
  ])(
    'does not let unrelated pricing or policy evidence satisfy a commercial claim cited only to $citedSource',
    ({ citedEvidenceId, citedEvidence, unrelatedEvidence }) => {
      const brief = healthyBrief();
      const claim = fixtureClaim(
        'claim_ns_commercial_terms',
        'The commercial terms are approved for signature.',
        citedEvidenceId
      );
      const locallyUngrounded = {
        ...brief,
        sourceEvidence: {
          evidence: [
            ...brief.sourceEvidence.evidence.filter(
              (entry) => entry.sourceType !== 'pricing' && entry.sourceType !== 'policy'
            ),
            ...(citedEvidence === undefined ? [] : [citedEvidence]),
            unrelatedEvidence
          ]
        },
        negotiationState: {
          ...brief.negotiationState,
          currentState: claim.statement,
          claims: [claim]
        }
      } as DealBrief;
      expect(rules(locallyUngrounded)).toContain('commercial-claim-provenance');
    }
  );

  it.each([
    {
      kind: 'a word-denominated monetary amount',
      statement:
        'The renewal is valued at four million two hundred seventeen thousand five hundred dollars.'
    },
    {
      kind: 'a payment schedule',
      statement: 'The payment schedule requires four equal quarterly installments.'
    },
    {
      kind: 'a legal term',
      statement: 'The contract terms include uncapped liability.'
    }
  ])('requires claim-local pricing or policy provenance for $kind', ({ statement }) => {
    const brief = healthyBrief();
    const locallyUngrounded = {
      ...brief,
      negotiationState: {
        ...brief.negotiationState,
        currentState: statement,
        claims: [fixtureClaim('claim_ns_material_term', statement, contactEvidenceId('CON-3002'))]
      }
    } as DealBrief;
    expect(rules(locallyUngrounded)).toContain('commercial-claim-provenance');
  });

  it.each([
    {
      kind: 'word-denominated monetary amount',
      statement:
        'The renewal is valued at four million two hundred seventeen thousand five hundred dollars.',
      evidenceId: PRICING_EVIDENCE_ID,
      summary: 'The proposed ACV is 4217500.'
    },
    {
      kind: 'payment schedule',
      statement: 'The payment schedule requires four equal quarterly installments.',
      evidenceId: PRICING_EVIDENCE_ID,
      summary: 'The customer accepted four equal quarterly installments.'
    },
    {
      kind: 'legal term',
      statement: 'The contract terms include uncapped liability.',
      evidenceId: LEGAL_PRICING_EVIDENCE_ID,
      summary: 'No concession is requested; contract terms include uncapped liability.'
    }
  ])('accepts a $kind with claim-local pricing provenance', ({ statement, evidenceId, summary }) => {
    const brief = healthyBrief();
    const locallyGrounded = {
      ...brief,
      sourceEvidence: {
        evidence: [
          ...brief.sourceEvidence.evidence,
          evidenceEntry(evidenceId, 'pricing', summary, 'claim_ev_local_pricing')
        ]
      },
      negotiationState: {
        ...brief.negotiationState,
        currentState: statement,
        claims: [fixtureClaim('claim_ns_local_pricing', statement, evidenceId)]
      }
    } as DealBrief;
    expect(rules(locallyGrounded)).not.toContain('commercial-claim-provenance');
  });

  it.each(['pricing', 'policy'] as const)(
    'rejects an unresolved evidence id whose path spoofs the %s source family',
    (sourceType) => {
      const brief = healthyBrief();
      const contactCitation = fixtureCitation(contactEvidenceId('CON-3002'));
      const spoofed = {
        ...brief,
        negotiationState: {
          ...brief.negotiationState,
          claims: [
            {
              id: 'claim_ns_spoofed_provenance',
              statement: 'The renewal includes a 15 percent discount.',
              confidence: 1,
              citations: [
                {
                  ...contactCitation,
                  evidenceId: `${sourceType}:not-in-source-evidence:0`
                }
              ]
            }
          ]
        }
      } as DealBrief;
      expect(rules(spoofed)).toContain('commercial-claim-provenance');
    }
  );

  it('does not classify the action owner Deal Desk as a commercial claim', () => {
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
      },
      recommendedNextActions: {
        actions: brief.recommendedNextActions.actions.map((action) => ({
          ...action,
          owner: 'Deal Desk'
        }))
      }
    } as DealBrief;
    expect(rules(operational)).not.toContain('commercial-claim-provenance');
  });

  it('does not classify an order-form document workflow action as a commercial term', () => {
    const brief = healthyBrief();
    const statement = 'Send revised order form and migration success plan by 2026-04-28.';
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
            'claim_ns_order_form_workflow',
            'The rollout model is under review with the account team.',
            contactEvidenceId('CON-3002')
          )
        ]
      },
      recommendedNextActions: {
        actions: [
          { action: statement, audience: 'internal', priority: 'high', rationale: statement,
          claims: [
            fixtureClaim(
              'claim_act_order_form_workflow',
              statement,
              contactEvidenceId('CON-3002')
            )
          ] }
        ]
      }
    } as DealBrief;
    expect(rules(operational)).not.toContain('commercial-claim-provenance');
  });

  it('still requires commercial provenance for an assertion about order-form terms', () => {
    const brief = healthyBrief();
    const statement = 'The order form terms are approved for signature.';
    const unprovenanced = {
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
            'claim_ns_order_form_terms',
            'The rollout model is under review with the account team.',
            contactEvidenceId('CON-3002')
          )
        ]
      },
      recommendedNextActions: {
        actions: [
          { action: statement, audience: 'internal', priority: 'high', rationale: statement,
          claims: [
            fixtureClaim(
              'claim_act_order_form_terms',
              statement,
              contactEvidenceId('CON-3002')
            )
          ] }
        ]
      }
    } as DealBrief;
    expect(rules(unprovenanced)).toContain('commercial-claim-provenance');
  });

  it.each([
    'Missing payment schedule could become a last-minute blocker.',
    'Executive buyer linked expansion decision to measurable proof outcomes and staged payment terms.',
    'Executive stakeholders disagree on whether aggressive discounting or risk mitigation should lead the final negotiations.',
    'Final prep call identified approval gates for discount, liability language, and restricted-source use.'
  ])('does not classify a negotiation topic as an asserted commercial term: %s', (statement) => {
    const brief = healthyBrief();
    const topicOnly = {
      ...brief,
      sourceEvidence: {
        evidence: brief.sourceEvidence.evidence.filter(
          (entry) => entry.sourceType !== 'pricing' && entry.sourceType !== 'policy'
        )
      },
      negotiationState: {
        currentState: statement,
        leverage: [],
        risks: ['Regional exception handling remains unresolved.'],
        claims: [fixtureClaim('claim_ns_commercial_topic', statement, contactEvidenceId('CON-3002'))]
      }
    } as DealBrief;
    expect(rules(topicOnly)).not.toContain('commercial-claim-provenance');
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
