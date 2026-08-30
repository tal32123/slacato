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
    expect(plan.sourceLimits).toEqual({ gong_summary: 2, gong_transcript: 4, policy: 4, pricing: 2, salesforce: 7, slack: 2 });
    expect(plan.policyReservation).toEqual({ resultSlots: 1, contextCharacters: 500 });
    expect(Object.entries(plan.sourceLimits).every(([source, limit]) =>
      limit > 0 && (source === 'salesforce' || limit <= 4)
    )).toBe(true);
    expect(plan.maxContextCharacters).toBe(2_000);
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
