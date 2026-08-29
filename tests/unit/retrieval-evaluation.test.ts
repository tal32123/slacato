import { describe, expect, it } from 'vitest';
import { evaluateRetrievalResults } from '../../scripts/evaluate.js';

describe('deterministic retrieval evaluation', () => {
  it('computes precision, recall, and leakage from hand-checked relevance labels', () => {
    expect(evaluateRetrievalResults([
      { id: 'allowed', k: 2, relevantEvidenceIds: ['a', 'b'], retrievedEvidenceIds: ['a', 'a'], denied: false },
      { id: 'denied', k: 2, relevantEvidenceIds: [], retrievedEvidenceIds: [], denied: true }
    ])).toEqual({
      cases: [
        { id: 'allowed', precisionAtK: 0.5, recallAtK: 0.5, leakedEvidence: 0, retrieved: 1, relevantEvidenceIds: ['a', 'b'], retrievedEvidenceIds: ['a'] },
        { id: 'denied', precisionAtK: 1, recallAtK: 1, leakedEvidence: 0, retrieved: 0, relevantEvidenceIds: [], retrievedEvidenceIds: [] }
      ],
      summary: { macroPrecisionAtK: 0.5, macroRecallAtK: 0.5, permissionLeakage: 0 }
    });
  });
});
