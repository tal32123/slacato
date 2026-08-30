import { dealWorkspaceViewSchema } from '@slacato/contracts';
import type { AuthorizedDeal, DealEvidence, LatestDealRun } from '@slacato/core';
import { expect, it } from 'vitest';
import { renderDealWorkspace } from '../../apps/api/src/modules/deals/deal-workspace.mapper';

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

const target: AuthorizedDeal = {
  opportunityId: 'OPP-1',
  opportunityName: 'Renewal',
  accountId: 'ACC-1',
  accountName: 'Northstar',
  restricted: false,
  createdAt: '2026-08-29T00:00:00.000Z',
  recordContent: null,
  latestRun: null
};

const opportunityEvidence: DealEvidence = {
  id: 'salesforce:OPP-1:0',
  sourceType: 'salesforce',
  sensitivity: 'standard',
  eventDate: null,
  sourceLocator: 'salesforce/opportunities.tsv#OPP-1/chunk-0',
  createdAt: '2026-08-29T00:00:00.000Z',
  content:
    'opportunityId: OPP-1\nopportunityName: Renewal\naccountName: Northstar\nstage: Negotiation\nowner: Test Owner\ncloseDate: 2026-09-30\nacv: 1000\nprobability: 60\nriskLevel: medium\nnextStep: Confirm renewal terms by 2026-09-15'
};

it('renders a full workspace view whose deal, source snapshot, and legacy brief satisfy the wire schema', () => {
  const workspace = renderDealWorkspace({
    sessionVersion: 'session-v1',
    target,
    latestRun: undefined,
    opportunityRows: [opportunityEvidence],
    stakeholderRows: [],
    supplementalRows: []
  });

  expect(() => dealWorkspaceViewSchema.parse(workspace)).not.toThrow();
  expect(workspace.sessionVersion).toBe('session-v1');
  expect(workspace.deal.stage).toBe('Negotiation');
  expect(workspace.deal.riskLevel).toBe('medium');
  expect(workspace.generatedOutput).toBeNull();
  expect(workspace.sourceSnapshot.type).toBe('source_snapshot');
  expect(workspace.brief).toEqual(workspace.sourceSnapshot.evidenceOverview);
  expect(workspace.evidence.map((item) => item.id)).toEqual([opportunityEvidence.id]);
});

it('falls back to the unavailable-stage and unknown-risk placeholders when no authorized opportunity record is found', () => {
  const workspace = renderDealWorkspace({
    sessionVersion: 'session-v2',
    target,
    latestRun: undefined,
    opportunityRows: [],
    stakeholderRows: [],
    supplementalRows: []
  });

  expect(() => dealWorkspaceViewSchema.parse(workspace)).not.toThrow();
  expect(workspace.deal.stage).toBe('Stage unavailable');
  expect(workspace.deal.riskLevel).toBe('unknown');
  expect(workspace.generatedOutput).toBeNull();
  expect(workspace.evidence).toEqual([]);
});

it('surfaces the latest run status without producing generated output when no draft or finalized brief exists', () => {
  const latestRun: LatestDealRun = {
    runId: 'run-1',
    status: 'awaiting_approval',
    updatedAt: '2026-08-29T02:00:00.000Z',
    generatedOutput: null
  };

  const workspace = renderDealWorkspace({
    sessionVersion: 'session-v3',
    target,
    latestRun,
    opportunityRows: [opportunityEvidence],
    stakeholderRows: [],
    supplementalRows: []
  });

  expect(() => dealWorkspaceViewSchema.parse(workspace)).not.toThrow();
  expect(workspace.deal.latestRun).toEqual({
    status: 'awaiting_approval',
    updatedAt: '2026-08-29T02:00:00.000Z'
  });
  expect(workspace.generatedOutput).toBeNull();
  expect(workspace.brief).toEqual(workspace.sourceSnapshot.evidenceOverview);
});
