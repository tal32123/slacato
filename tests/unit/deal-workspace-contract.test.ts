import { dealWorkspaceViewSchema } from '@slacato/contracts';
import {
  type AuthorizedDeal,
  type DealEvidence,
  dealBriefSchema,
  type LatestDealRun
} from '@slacato/core';
import { expect, it } from 'vitest';
import { renderDealWorkspace } from '../../apps/api/src/modules/deals/deal-workspace.mapper';

const section = {
  title: 'Evidence overview',
  paragraphs: [],
  items: [],
  citationIds: [],
  accountTeamUpdateImpact: false
};

it('accepts a source snapshot and a separately run-linked generated draft in the workspace response', () => {
  const content = {
    status: 'generated',
    overallConfidence: 0.5,
    sections: {
      dealSnapshot: section,
      executiveSummary: section,
      buyerGoalsAndBusinessDrivers: section,
      stakeholderMap: section,
      negotiationState: section,
      recommendedNextActions: section,
      missingInformation: section,
      sourceEvidence: section,
      confidenceAndReviewWarnings: section
    },
    stakeholders: [],
    actions: [],
    warnings: []
  };

  expect(() =>
    dealWorkspaceViewSchema.parse({
      sessionVersion: 'session-v1',
      deal: {
        opportunityId: 'OPP-1',
        opportunityName: 'Renewal',
        accountName: 'Northstar',
        stage: 'Negotiation',
        owner: null,
        closeDate: null,
        amount: null,
        currency: null,
        probability: null,
        riskLevel: 'unknown',
        restricted: false,
        createdAt: '2026-08-29T00:00:00.000Z',
        latestRun: null
      },
      sourceSnapshot: {
        type: 'source_snapshot',
        label: 'Source snapshot',
        evidenceOverview: { ...content, status: 'source_backed' }
      },
      generatedOutput: {
        type: 'generated_output',
        lifecycle: 'draft',
        producingRun: {
          id: 'run-42',
          status: 'awaiting_approval',
          updatedAt: '2026-08-29T01:00:00.000Z'
        },
        approvalReview: { approvalSubjectId: 'approval-1' },
        content
      },
      brief: content,
      evidence: []
    })
  ).not.toThrow();
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

const opportunityEvidenceWithCompetitor: DealEvidence = {
  id: 'salesforce:OPP-1:1',
  sourceType: 'salesforce',
  sensitivity: 'standard',
  eventDate: null,
  sourceLocator: 'salesforce/opportunities.tsv#OPP-1/chunk-0',
  createdAt: '2026-08-29T00:00:00.000Z',
  content: `${opportunityEvidence.content}\nprimaryCompetitor: Rival Corp`
};

const conversationEvidence: DealEvidence = {
  id: 'gong_summary:CALL-1:0',
  sourceType: 'gong_summary',
  sensitivity: 'standard',
  eventDate: '2026-08-20',
  sourceLocator: 'gong/gong_call_summaries.tsv#CALL-1',
  createdAt: '2026-08-20T00:00:00.000Z',
  content:
    'callId: CALL-1\nsummary: Final document review found no new commercial objections.\nkeyPoints: Executive buyer wants fewer exceptions, infrastructure lead wants a rollout plan\ncustomerSentiment: positive\nrisks: Renewal timing risk if approvals slip\nnextSteps: Confirm approvals by 2026-09-01'
};

it('derives the executive summary and buyer goals paragraphs from different authorized source material', () => {
  const workspace = renderDealWorkspace({
    sessionVersion: 'session-v4',
    target,
    latestRun: undefined,
    opportunityRows: [opportunityEvidenceWithCompetitor],
    stakeholderRows: [],
    supplementalRows: [conversationEvidence]
  });

  const brief = workspace.sourceSnapshot.evidenceOverview;
  const executiveSummaryParagraph = brief.sections.executiveSummary.paragraphs[0];
  const buyerGoalsParagraph = brief.sections.buyerGoalsAndBusinessDrivers.paragraphs[0];

  expect(executiveSummaryParagraph).toBe(
    'Final document review found no new commercial objections.'
  );
  expect(buyerGoalsParagraph).toContain('Rival Corp');
  expect(buyerGoalsParagraph).not.toBe(executiveSummaryParagraph);

  // No two sections should open with the identical restated sentence: each must add information.
  const firstParagraphs = Object.values(brief.sections)
    .map((section) => section.paragraphs[0])
    .filter((paragraph): paragraph is string => paragraph !== undefined && paragraph.length > 0);
  expect(new Set(firstParagraphs).size).toBe(firstParagraphs.length);
});

it('surfaces the latest run status without producing generated output when no draft or finalized brief exists', () => {
  const latestRun: LatestDealRun = {
    runId: 'run-1',
    status: 'awaiting_approval',
    updatedAt: '2026-08-29T02:00:00.000Z',
    generatedOutput: null,
    approvalReview: null
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

const generatedBrief = dealBriefSchema.parse({
  dealSnapshot: {
    accountName: 'Northstar',
    opportunityName: 'Renewal',
    stage: 'Negotiation'
  },
  executiveSummary: { narrative: 'A generated draft is ready for review.' },
  buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
  stakeholderMap: { stakeholders: [] },
  negotiationState: { currentState: 'The renewal remains active.', risks: [] },
  recommendedNextActions: { actions: [] },
  missingInformation: { items: [] },
  sourceEvidence: { evidence: [] },
  confidenceAndReviewWarnings: { overallConfidence: 0.5, warnings: [] }
});

function generatedLatestRun(approvalReview: LatestDealRun['approvalReview']): LatestDealRun {
  return {
    runId: 'run-generated',
    status: 'awaiting_approval',
    updatedAt: '2026-08-29T03:00:00.000Z',
    generatedOutput: { lifecycle: 'draft', brief: generatedBrief },
    approvalReview
  };
}

it('projects only the current approval subject descriptor beside an authorized generated output', () => {
  const workspace = renderDealWorkspace({
    sessionVersion: 'session-v5',
    target,
    latestRun: generatedLatestRun({ approvalSubjectId: 'approval-current' }),
    opportunityRows: [opportunityEvidence],
    stakeholderRows: [],
    supplementalRows: []
  });

  expect(workspace.generatedOutput?.approvalReview).toEqual({
    approvalSubjectId: 'approval-current'
  });
});

it('projects a null approval review when an authorized generated output has no current subject', () => {
  const workspace = renderDealWorkspace({
    sessionVersion: 'session-v6',
    target,
    latestRun: generatedLatestRun(null),
    opportunityRows: [opportunityEvidence],
    stakeholderRows: [],
    supplementalRows: []
  });

  expect(workspace.generatedOutput?.approvalReview).toBeNull();
});
