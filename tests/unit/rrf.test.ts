import { describe, expect, it } from 'vitest';
import {
  applyEvidenceAdjustments,
  buildEvidencePlan,
  reciprocalRankFusion
} from '@slacato/core';

describe('reciprocalRankFusion', () => {
  it('fuses stable identifiers with literal k=60 scores and deterministic ties', () => {
    expect(reciprocalRankFusion([
      ['evidence_b', 'evidence_a'],
      ['evidence_a', 'evidence_c']
    ], 60)).toEqual([
      { id: 'evidence_a', score: (1 / 62) + (1 / 61) },
      { id: 'evidence_b', score: 1 / 61 },
      { id: 'evidence_c', score: 1 / 62 }
    ]);
  });

  it('counts a duplicate identifier only once per ranked list', () => {
    expect(reciprocalRankFusion([['evidence_a', 'evidence_a']], 60)).toEqual([
      { id: 'evidence_a', score: 1 / 61 }
    ]);
  });
});

describe('EvidencePlan', () => {
  it('reserves mandatory policy evidence and keeps source and context budgets bounded', () => {
    const plan = buildEvidencePlan({ query: 'termination discount', limit: 4, maxContextCharacters: 2_000 });
    expect(plan.fusionK).toBe(60);
    expect(plan.exactLookups).toEqual(['account', 'opportunity', 'contacts']);
    expect(plan.sectionQueries.map((entry) => entry.section)).toEqual([
      'deal_snapshot', 'buyer_goals', 'stakeholders', 'negotiation_state', 'next_actions', 'missing_information'
    ]);
    expect(plan.mandatorySourceTypes).toEqual(['policy']);
    expect(plan.sourceLimits).toEqual({ gong_summary: 2, gong_transcript: 2, policy: 4, pricing: 2, salesforce: 2, slack: 2 });
    expect(plan.policyReservation).toEqual({ resultSlots: 1, contextCharacters: 500 });
    expect(Object.entries(plan.sourceLimits).every(([, limit]) => limit > 0 && limit <= 4)).toBe(true);
    expect(plan.maxContextCharacters).toBe(2_000);
    // The always-surface CRM completeness guarantee (account + opportunity + 5 canonical contacts)
    // must stay separate from, and larger than, the hybrid-search Salesforce candidate window --
    // otherwise Salesforce crowds out relevant evidence in every hybrid search (see retriever.ts).
    expect(plan.crmRecordLimit).toBe(7);
    expect(plan.sourceLimits.salesforce).toBeLessThan(plan.crmRecordLimit);
  });

  it('never lets one non-primary source type dominate the hybrid-search candidate pool, at any requested limit', () => {
    // Intent, not a pinned number: no single source type (gong_transcript included) may be allowed
    // to admit a disproportionate share of RRF candidates per section query, no matter how large the
    // caller's `limit` is. gong_transcript previously passed `input.limit` straight through uncapped,
    // so a production limit of 20 let it admit 10x as many candidates as slack/salesforce/pricing/
    // gong_summary combined -- measured on a real run, that produced 18 gong_transcript chunks
    // (84.6% of prompt context) against a single, validated, but ultimately dropped Slack chunk
    // (1.26%). Policy is deliberately excluded: it is the plan's one mandatory source type with its
    // own always-surface completeness guarantee (CANONICAL_POLICY_SECTION_LIMIT), not a competing
    // candidate window.
    //
    // A stricter "every window must be identical" assertion would be wrong here: the documented fix
    // for further imbalance is raising Slack's window relative to gong_transcript's, which the share
    // bound below still allows but an equality check would reject. A `window < limit` check alone
    // would also miss the regression at limit=20, where an uncapped gong_transcript (=20) still sits
    // below the limit while dominating every other window (=2) -- share is the property that matters.
    const nonPrimarySourceTypes = ['gong_summary', 'gong_transcript', 'pricing', 'salesforce', 'slack'] as const;
    for (const limit of [4, 20]) {
      const plan = buildEvidencePlan({ query: 'termination discount', limit });
      const windows = nonPrimarySourceTypes.map((sourceType) => plan.sourceLimits[sourceType]);
      const total = windows.reduce((sum, window) => sum + window, 0);
      expect(Math.max(...windows) / total).toBeLessThanOrEqual(0.4);
      // The shared window must not track the caller's limit once the limit grows past it -- that
      // would silently reintroduce the uncapped-gong_transcript bug for any source type.
      expect(windows.every((window) => window < limit)).toBe(true);
    }
  });
});

describe('evidence score adjustments', () => {
  it('keeps reliability and recency effects documented and bounded', () => {
    const adjusted = applyEvidenceAdjustments({
      fusionScore: 0.03,
      sourceType: 'slack',
      reliabilityClass: 'internal_collaboration',
      eventDate: '2026-08-01'
    }, new Date('2026-08-28T00:00:00.000Z'));
    expect(adjusted.reliabilityAdjustment).toBe(0.01);
    expect(adjusted.recencyAdjustment).toBeGreaterThanOrEqual(-0.02);
    expect(adjusted.recencyAdjustment).toBeLessThanOrEqual(0.02);
    expect(adjusted.score).toBeCloseTo(0.03 + adjusted.reliabilityAdjustment + adjusted.recencyAdjustment, 12);
  });

  it('never penalizes authoritative policy because it is old', () => {
    const adjusted = applyEvidenceAdjustments({
      fusionScore: 0.03,
      sourceType: 'policy',
      reliabilityClass: 'authoritative_policy',
      eventDate: '2020-01-01'
    }, new Date('2026-08-28T00:00:00.000Z'));
    expect(adjusted.reliabilityAdjustment).toBe(0.02);
    expect(adjusted.recencyAdjustment).toBe(0);
  });
});
