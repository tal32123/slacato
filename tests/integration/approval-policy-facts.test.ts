import type { DealBrief } from '@slacato/core';
import { dealBriefSchema, decideApprovalRequirement } from '@slacato/core';
import type { DatabaseClient } from '@slacato/infrastructure/db/client';
import { PostgresDealBriefPolicyFacts } from '@slacato/infrastructure/db/repositories/deal-brief-access';
import { describe, expect, it } from 'vitest';
import { parseFixtureSet } from '../../scripts/fixture-loader';

type StoredPolicyFacts = Readonly<{
  discount_percent: string;
  renewal_uplift_percent: string;
  liability_cap_changed: boolean;
  data_retention_language: boolean;
  restricted_research_language: boolean;
  customer_specific_security_language: boolean;
  customer_facing_concession_language: boolean;
  conflicting_evidence: boolean;
  missing_material_evidence: boolean;
}>;

const canonicalFixtures = parseFixtureSet('fixtures/cato');

/** Builds a brief whose variable policy signals are actions, confidence, warnings, and open questions. */
function brief(
  input: Readonly<{
    missingInformation?: DealBrief['missingInformation']['items'];
    actions?: DealBrief['recommendedNextActions']['actions'];
    warnings?: DealBrief['confidenceAndReviewWarnings']['warnings'];
    overallConfidence?: number;
  }> = {}
): DealBrief {
  return dealBriefSchema.parse({
    dealSnapshot: {
      accountName: 'Policy Facts',
      opportunityName: 'Policy Facts Opportunity',
      stage: 'Negotiate'
    },
    executiveSummary: { narrative: 'The renewal is progressing on approved commercial terms.' },
    buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
    stakeholderMap: { stakeholders: [] },
    negotiationState: { currentState: 'The commercial position is settled.', risks: [] },
    recommendedNextActions: { actions: input.actions ?? [] },
    missingInformation: { items: input.missingInformation ?? [] },
    sourceEvidence: { evidence: [] },
    confidenceAndReviewWarnings: {
      overallConfidence: input.overallConfidence ?? 0.95,
      warnings: input.warnings ?? []
    }
  });
}

/** Exercises the repository mapping without coupling these policy tests to shared PostgreSQL. */
function repositoryFor(row: StoredPolicyFacts): PostgresDealBriefPolicyFacts {
  const sql = (async () => [row]) as unknown as DatabaseClient['sql'];
  return new PostgresDealBriefPolicyFacts({
    sql,
    db: {} as DatabaseClient['db'],
    close: async () => {}
  });
}

/** Mirrors scripts/ingest.ts policy-fact derivation for one canonical fixture opportunity. */
function ingestedFactsFor(opportunityId: string): StoredPolicyFacts {
  const opportunity = canonicalFixtures.opportunities.find(
    (candidate) => candidate.opportunityId === opportunityId
  );
  if (opportunity === undefined) throw new Error(`Missing canonical fixture ${opportunityId}`);
  const notes = canonicalFixtures.pricingNotes.filter(
    (note) => note.opportunityId === opportunityId
  );
  const discountPercent = Math.max(0, ...notes.map((note) => note.requestedDiscount));
  const renewalUpliftPercent =
    notes.length === 0 ? 0 : Math.min(...notes.map((note) => note.renewalUplift));
  const liabilityCapChanged = notes.some((note) => /liability language/i.test(note.pricingNotes));
  const restrictedLanguage = opportunity.restrictedAccess;
  return {
    discount_percent: String(discountPercent),
    renewal_uplift_percent: String(renewalUpliftPercent),
    liability_cap_changed: liabilityCapChanged,
    data_retention_language: false,
    restricted_research_language: restrictedLanguage,
    customer_specific_security_language: restrictedLanguage,
    customer_facing_concession_language: restrictedLanguage && discountPercent > 10,
    conflicting_evidence: false,
    missing_material_evidence: false
  };
}

async function requirementFor(
  opportunityId: string,
  storedFacts: StoredPolicyFacts,
  payload: DealBrief
) {
  return decideApprovalRequirement(
    await repositoryFor(storedFacts).forBrief(opportunityId, payload)
  );
}

describe('deal brief policy facts', () => {
  it('does not route a standard deal merely because its brief records unsupported-claim follow-up', async () => {
    const requirement = await requirementFor(
      'OPP-1001',
      ingestedFactsFor('OPP-1001'),
      brief({
        missingInformation: [
          {
            question: 'Confirm the final owner matrix with the named account owner.',
            whyItMatters: 'The deal team cannot close the packet without it.'
          }
        ],
        warnings: [
          {
            code: 'INSUFFICIENT_CLAIM_SUPPORT',
            severity: 'warning',
            message: 'No single cited evidence unit supports the complete material relation.',
            claimIds: []
          }
        ]
      })
    );

    expect(requirement.policyTriggers).toEqual([]);
    expect(requirement.entries).toEqual([]);
  });

  it('routes a grounded customer-audience action to account-owner approval', async () => {
    const payload = dealBriefSchema.parse({
      ...brief(),
      recommendedNextActions: {
        actions: [
          {
            action: 'Send revised order form and migration success plan by 2026-04-28',
            audience: 'customer',
            priority: 'high',
            rationale: 'Complete the next step recorded on the opportunity.',
            claims: [
              {
                id: 'claim_customer_audience_action',
                statement: 'Send revised order form and migration success plan by 2026-04-28',
                confidence: 1,
                citations: [
                  {
                    id: 'citation_customer_audience_action',
                    evidenceId: 'salesforce:OPP-1001:0',
                    locator: 'salesforce/opportunities.tsv#OPP-1001#chunk-0'
                  }
                ]
              }
            ]
          }
        ]
      }
    });
    const requirement = await requirementFor(
      'OPP-1001',
      ingestedFactsFor('OPP-1001'),
      payload
    );

    expect(requirement.policyTriggers).toEqual(['customer_facing_language']);
    expect(requirement.entries).toEqual([
      expect.objectContaining({
        category: 'customer_communication',
        eligibleAuthorities: ['account_owner'],
        policyTriggers: ['customer_facing_language']
      })
    ]);
  });

  it.each([
    ['Use any arbitrary wording at all', 'customer', true],
    ['Send the signed proposal to the buyer immediately', 'internal', false],
    ['We can provide the packet to the customer', 'internal', false]
  ] as const)(
    'uses typed audience rather than action wording at the repository-policy boundary: %s',
    async (action, audience, expected) => {
      const requirement = await requirementFor(
        'OPP-1001',
        ingestedFactsFor('OPP-1001'),
        brief({
          actions: [
            {
              action,
              audience,
              priority: 'high',
              rationale: 'Complete the recorded next step.',
              claims: []
            }
          ]
        })
      );

      expect(requirement.policyTriggers).toEqual(
        expected ? ['customer_facing_language'] : []
      );
      expect(requirement.entries).toEqual(
        expected
          ? [
              expect.objectContaining({
                category: 'customer_communication',
                eligibleAuthorities: ['account_owner'],
                policyTriggers: ['customer_facing_language']
              })
            ]
          : []
      );
    }
  );

  it('deduplicates customer-audience and concession approval into one account-owner quorum entry', async () => {
    const storedFacts = {
      ...ingestedFactsFor('OPP-1001'),
      customer_facing_concession_language: true
    };
    const requirement = await requirementFor(
      'OPP-1001',
      storedFacts,
      brief({
        actions: [
          {
            action: 'Schedule a meeting with the buyer',
            audience: 'customer',
            priority: 'high',
            rationale: 'Complete the grounded next step.',
            claims: []
          }
        ]
      })
    );

    expect(requirement.policyTriggers).toEqual([
      'customer_facing_language',
      'customer_facing_concession_language'
    ]);
    expect(requirement.entries).toEqual([
      expect.objectContaining({
        category: 'customer_communication',
        eligibleAuthorities: ['account_owner'],
        policyTriggers: [
          'customer_facing_language',
          'customer_facing_concession_language'
        ]
      })
    ]);
  });

  it('routes explicit missing material evidence to scoped human review', async () => {
    const requirement = await requirementFor(
      'OPP-1001',
      ingestedFactsFor('OPP-1001'),
      brief({
        warnings: [
          {
            code: 'MISSING_MATERIAL_EVIDENCE',
            severity: 'critical',
            message: 'Authorized sources omit a material term of the renewal.',
            claimIds: []
          }
        ]
      })
    );

    expect(requirement.policyTriggers).toEqual(['missing_material_evidence']);
    expect(requirement.entries).toEqual([
      expect.objectContaining({
        category: 'evidence_review',
        eligibleAuthorities: ['account_owner', 'sales_leader'],
        policyTriggers: ['missing_material_evidence']
      })
    ]);
  });

  it('routes structured missing material evidence even without a generated warning', async () => {
    const storedFacts = {
      ...ingestedFactsFor('OPP-1001'),
      missing_material_evidence: true
    };
    const requirement = await requirementFor('OPP-1001', storedFacts, brief());

    expect(requirement.policyTriggers).toEqual(['missing_material_evidence']);
    expect(requirement.entries[0]).toMatchObject({ category: 'evidence_review' });
  });

  it('keeps the restricted OPP-1003 demo on deterministic commercial and legal approval paths', async () => {
    const requirement = await requirementFor(
      'OPP-1003',
      ingestedFactsFor('OPP-1003'),
      brief({
        missingInformation: [
          {
            question: 'Confirm the final negotiation owner.',
            whyItMatters: 'The account team needs one escalation path.'
          }
        ]
      })
    );

    expect(requirement.policyTriggers).toEqual([
      'discount_above_10_percent',
      'negative_renewal_uplift',
      'discount_above_15_percent',
      'liability_cap_change',
      'restricted_research_language',
      'customer_specific_security_language',
      'customer_facing_concession_language'
    ]);
    expect(
      requirement.entries.map(({ category, eligibleAuthorities }) => ({
        category,
        eligibleAuthorities
      }))
    ).toEqual([
      { category: 'commercial_discount', eligibleAuthorities: ['deal_desk'] },
      { category: 'commercial_discount', eligibleAuthorities: ['sales_leader'] },
      { category: 'legal_terms', eligibleAuthorities: ['legal_reviewer'] },
      { category: 'customer_concession', eligibleAuthorities: ['account_owner'] }
    ]);
  });
});
