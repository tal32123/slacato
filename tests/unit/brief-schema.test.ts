import { describe, expect, it } from 'vitest';
import {
  MAX_SERIALIZED_ARTIFACT_BYTES,
  conversationArtifactSchema,
  dealBriefSchema,
  evidenceSummarySchema,
  evidenceIdSchema,
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
    expect(() => evidenceIdSchema.parse('user_8g9rk')).toThrow();
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
});
