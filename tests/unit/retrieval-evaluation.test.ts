import { describe, expect, it } from 'vitest';
import { evaluateRetrievalResults } from '../../scripts/evaluate.js';

describe('deterministic retrieval evaluation', () => {
  it('computes precision, recall, and leakage from hand-checked relevance labels', () => {
    expect(evaluateRetrievalResults([
      { id: 'allowed', relevantEvidenceIds: ['a', 'b'], retrievedEvidenceIds: ['a', 'c'], denied: false },
      { id: 'denied', relevantEvidenceIds: [], retrievedEvidenceIds: [], denied: true }
    ])).toEqual({
      cases: [
        { id: 'allowed', precisionAtK: 0.5, recallAtK: 0.5, leakedEvidence: 0, retrieved: 2, relevantEvidenceIds: ['a', 'b'], retrievedEvidenceIds: ['a', 'c'] },
        { id: 'denied', precisionAtK: 1, recallAtK: 1, leakedEvidence: 0, retrieved: 0, relevantEvidenceIds: [], retrievedEvidenceIds: [] }
      ],
      summary: { macroPrecisionAtK: 0.75, macroRecallAtK: 0.75, permissionLeakage: 0 }
    });
  });
});
