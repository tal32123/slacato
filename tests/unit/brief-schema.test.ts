import { describe, expect, it } from 'vitest';
import {
  MAX_SERIALIZED_ARTIFACT_BYTES,
  commercialArtifactSchema,
  conversationArtifactSchema,
  dealBriefSchema,
  evidenceSummarySchema,
  evidenceIdSchema,
  stakeholderArtifactSchema,
  strategyArtifactSchema,
  userIdSchema
} from '@slacato/core';

const validBrief = {
  dealSnapshot: {
    accountName: 'Acme',
    opportunityName: 'Expansion',
    stage: 'Negotiation',
    closeDate: '2026-09-30'
  },
  executiveSummary: { narrative: 'Acme is evaluating an expansion.' },
  buyerGoalsAndBusinessDrivers: { goals: ['Reduce incident response time'], businessDrivers: ['Meet reliability target'] },
  stakeholderMap: { stakeholders: [] },
  negotiationState: { currentState: 'Commercial terms are under review.', risks: [] },
  recommendedNextActions: { actions: [] },
  missingInformation: { items: [] },
  sourceEvidence: { evidence: [] },
  confidenceAndReviewWarnings: { overallConfidence: 0.8, warnings: [] }
};

describe('DealBrief schema', () => {
  it('rejects a brief missing any required assignment section', () => {
    expect(() => dealBriefSchema.parse({ executiveSummary: { narrative: 'x' } })).toThrow();
  });

  it('rejects unknown fields at its external boundary', () => {
    expect(() => dealBriefSchema.parse({ ...validBrief, internalNotes: 'do not persist' })).toThrow();
  });

  it('validates prefixed opaque IDs at runtime', () => {
    expect(userIdSchema.parse('user_8g9rk')).toBe('user_8g9rk');
    expect(evidenceIdSchema.parse('gong_transcript:CALL-008:transcript:0')).toBe('gong_transcript:CALL-008:transcript:0');
    expect(() => evidenceIdSchema.parse('user_8g9rk')).toThrow();
    expect(() => evidenceIdSchema.parse('gong_transcript::0')).toThrow();
  });

  it('rejects a specialist artifact beyond the serialized-byte budget', () => {
    const oversized = {
      evidenceManifestId: 'manifest_1',
      goals: ['x'.repeat(MAX_SERIALIZED_ARTIFACT_BYTES)],
      concerns: [],
      commitments: [],
      objections: [],
      missingContext: [],
      claims: [],
      reviewWarnings: []
    };

    expect(() => conversationArtifactSchema.parse(oversized)).toThrow();
  });

  it('bounds generated evidence timestamps even when their ISO fractional precision is valid', () => {
    expect(() => evidenceSummarySchema.parse({
      evidenceId: 'evidence_1',
      sourceType: 'crm',
      summary: 'A CRM record.',
      capturedAt: '2026-08-28T18:44:53.123456789012345678901234567890123456789012345678901234567890Z',
      claims: []
    })).toThrow();
  });

  it('deeply freezes parsed briefs and specialist artifacts without freezing caller input', () => {
    const input = {
      ...validBrief,
      stakeholderMap: {
        stakeholders: [{
          name: 'Alex',
          role: 'champion' as const,
          influence: 'high' as const,
          relationship: 'positive' as const,
          goals: ['Accelerate rollout'],
          concerns: [],
          claims: []
        }]
      }
    };
    const brief = dealBriefSchema.parse(input);
    const conversation = conversationArtifactSchema.parse({
      evidenceManifestId: 'manifest_1',
      goals: [],
      concerns: [],
      commitments: [],
      objections: [],
      missingContext: [],
      claims: [],
      reviewWarnings: []
    });
    const stakeholder = stakeholderArtifactSchema.parse({
      evidenceManifestId: 'manifest_1',
      stakeholders: input.stakeholderMap.stakeholders,
      coverageGaps: [],
      claims: [],
      reviewWarnings: []
    });
    const commercial = commercialArtifactSchema.parse({
      evidenceManifestId: 'manifest_1',
      commercialTerms: [{ term: 'Term', status: 'proposed', detail: 'Detail', claims: [] }],
      policyTriggers: [],
      claims: [],
      reviewWarnings: []
    });
    const strategy = strategyArtifactSchema.parse(input);

    expect(Object.isFrozen(brief)).toBe(true);
    expect(Object.isFrozen(brief.stakeholderMap)).toBe(true);
    expect(Object.isFrozen(brief.stakeholderMap.stakeholders)).toBe(true);
    expect(Object.isFrozen(brief.stakeholderMap.stakeholders[0])).toBe(true);
    expect(Object.isFrozen(conversation)).toBe(true);
    expect(Object.isFrozen(conversation.goals)).toBe(true);
    expect(Object.isFrozen(stakeholder)).toBe(true);
    expect(Object.isFrozen(stakeholder.stakeholders)).toBe(true);
    expect(Object.isFrozen(commercial)).toBe(true);
    expect(Object.isFrozen(commercial.commercialTerms[0])).toBe(true);
    expect(Object.isFrozen(strategy)).toBe(true);
    expect(Reflect.set(brief.stakeholderMap.stakeholders, 0, input.stakeholderMap.stakeholders[0])).toBe(false);
    expect(brief.stakeholderMap.stakeholders[0]?.name).toBe('Alex');
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.stakeholderMap.stakeholders)).toBe(false);
  });
});
