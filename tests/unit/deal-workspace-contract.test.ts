import { dealWorkspaceViewSchema } from '@slacato/contracts';
import { expect, it } from 'vitest';

const section = {
  title: 'Evidence overview', paragraphs: [], items: [], citationIds: [], accountTeamUpdateImpact: false
};

it('accepts a source snapshot and a separately run-linked generated draft in the workspace response', () => {
  const content = {
    status: 'generated', overallConfidence: 0.5,
    sections: {
      dealSnapshot: section, executiveSummary: section, buyerGoalsAndBusinessDrivers: section,
      stakeholderMap: section, negotiationState: section, recommendedNextActions: section,
      missingInformation: section, sourceEvidence: section, confidenceAndReviewWarnings: section
    },
    stakeholders: [], actions: [], warnings: []
  };

  expect(() => dealWorkspaceViewSchema.parse({
    sessionVersion: 'session-v1',
    deal: {
      opportunityId: 'OPP-1', opportunityName: 'Renewal', accountName: 'Northstar', stage: 'Negotiation',
      owner: null, closeDate: null, amount: null, currency: null, probability: null, riskLevel: 'unknown',
      restricted: false, createdAt: '2026-08-29T00:00:00.000Z', latestRun: null
    },
    sourceSnapshot: {
      type: 'source_snapshot', label: 'Source snapshot', evidenceOverview: { ...content, status: 'source_backed' }
    },
    generatedOutput: {
      type: 'generated_output', lifecycle: 'draft',
      producingRun: { id: 'run-42', status: 'awaiting_approval', updatedAt: '2026-08-29T01:00:00.000Z' },
      content
    },
    brief: content,
    evidence: []
  })).not.toThrow();
});
