import type { AuthorizedDeal, Claim, DealBrief, DealEvidence, LatestDealRun } from '@slacato/core';
import { expect, it } from 'vitest';
import { renderDealWorkspace } from '../../apps/api/src/modules/deals/deal-workspace.mapper';

const AUTHORIZED_EVIDENCE_ID = 'salesforce:OPP-1:0';
const CANONICAL_PROGRESS_CLAIM = 'The renewal is progressing.';
const FALSE_BOUND_RESTRICTED_FACT =
  'Restricted board memo says the buyer will be acquired by Rival Corp for 40M.';
const REASSOCIATED_CLOSE_DATE_WARNING =
  'Confirm the renewal close date is 2026-09-15 with the deal desk.';
const CANONICAL_UNCERTAINTY_CLAIM = 'The renewal close date is uncertain.';
const EDITED_UNCERTAINTY_WARNING =
  'Review the uncertainty in the renewal close date with the deal desk.';
const CANONICAL_UNCONFIRMED_CLAIM = 'Payment schedule is unconfirmed.';

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

const authorizedEvidence: DealEvidence = {
  id: AUTHORIZED_EVIDENCE_ID,
  sourceType: 'salesforce',
  sensitivity: 'standard',
  eventDate: null,
  sourceLocator: 'salesforce/opportunities.tsv#OPP-1/chunk-0',
  createdAt: '2026-08-29T00:00:00.000Z',
  content:
    'opportunityId: OPP-1\nopportunityName: Renewal\naccountName: Northstar\nstage: Negotiation\nowner: Test Owner\ncloseDate: 2026-09-30\nacv: 1000\nprobability: 60\nriskLevel: medium\nnextStep: Confirm renewal terms by 2026-09-15'
};

function authorizedClaim(id: string, statement: string): Claim {
  return {
    id,
    statement,
    confidence: 1,
    citations: [
      {
        id: `citation_${id}`,
        evidenceId: AUTHORIZED_EVIDENCE_ID,
        locator: 'salesforce/opportunities.tsv#OPP-1/chunk-0'
      }
    ]
  } as Claim;
}

function briefWithWarnings(
  warnings: readonly unknown[],
  warningSubject = CANONICAL_PROGRESS_CLAIM
): DealBrief {
  return {
    dealSnapshot: {
      accountName: 'Northstar',
      opportunityName: 'Renewal',
      stage: 'Negotiation'
    },
    executiveSummary: {
      narrative: warningSubject,
      claims: [authorizedClaim('claim_es_1', warningSubject)]
    },
    buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
    stakeholderMap: { stakeholders: [] },
    negotiationState: { currentState: 'Commercial terms are under review.', risks: [] },
    recommendedNextActions: { actions: [] },
    missingInformation: { items: [] },
    sourceEvidence: {
      evidence: [
        {
          evidenceId: AUTHORIZED_EVIDENCE_ID,
          sourceType: 'salesforce',
          summary: 'Renewal opportunity record.',
          capturedAt: '2026-08-29T00:00:00Z',
          claims: [authorizedClaim('claim_ev_1', 'Renewal opportunity record.')]
        }
      ]
    },
    confidenceAndReviewWarnings: { overallConfidence: 0.9, warnings }
  } as DealBrief;
}

function renderWorkspaceForNarrowerViewer(
  warnings: readonly unknown[],
  warningSubject = CANONICAL_PROGRESS_CLAIM
) {
  const latestRun: LatestDealRun = {
    runId: 'run-1',
    status: 'completed',
    updatedAt: '2026-08-29T02:00:00.000Z',
    generatedOutput: {
      lifecycle: 'finalized',
      brief: briefWithWarnings(warnings, warningSubject)
    },
    approvalReview: null
  };
  return renderDealWorkspace({
    sessionVersion: 'session-v1',
    target,
    latestRun,
    opportunityRows: [authorizedEvidence],
    stakeholderRows: [],
    supplementalRows: []
  });
}

it('does not authorize restricted warning prose through an unrelated harmless claim binding', () => {
  const warnings = [
    {
      code: 'FALSE_BOUND_REVIEWER_NOTE',
      severity: 'critical',
      message: FALSE_BOUND_RESTRICTED_FACT,
      claimIds: ['claim_es_1']
    }
  ];

  const workspace = renderWorkspaceForNarrowerViewer(warnings);
  expect(workspace.generatedOutput).not.toBeNull();

  const content = workspace.generatedOutput?.content;
  expect(content?.warnings).toEqual([]);
  expect(content?.sections.confidenceAndReviewWarnings.items).toEqual([]);

  const serializedWorkspace = JSON.stringify(workspace);
  expect(serializedWorkspace).not.toContain(FALSE_BOUND_RESTRICTED_FACT);
});

it('does not authorize a close date by reassociating words from separate authorized fields', () => {
  const workspace = renderWorkspaceForNarrowerViewer([
    {
      code: 'REASSOCIATED_CLOSE_DATE',
      severity: 'critical',
      message: REASSOCIATED_CLOSE_DATE_WARNING,
      claimIds: ['claim_es_1']
    }
  ]);

  const warnings = workspace.generatedOutput?.content.warnings;
  expect(warnings).toEqual([]);
  expect(JSON.stringify(workspace)).not.toContain(REASSOCIATED_CLOSE_DATE_WARNING);
});

it('retains an authorized uncertainty warning after a harmless reviewer paraphrase', () => {
  const workspace = renderWorkspaceForNarrowerViewer(
    [
      {
        code: 'CLOSE_DATE_UNCERTAINTY',
        severity: 'critical',
        message: EDITED_UNCERTAINTY_WARNING,
        claimIds: ['claim_es_1']
      }
    ],
    CANONICAL_UNCERTAINTY_CLAIM
  );

  const warnings = workspace.generatedOutput?.content.warnings;
  expect(warnings).toEqual([
    expect.objectContaining({
      severity: 'warning',
      message: CANONICAL_UNCERTAINTY_CLAIM,
      citationIds: [AUTHORIZED_EVIDENCE_ID]
    })
  ]);
  expect(JSON.stringify(warnings)).not.toContain(EDITED_UNCERTAINTY_WARNING);
});

it('retains an authorized unconfirmed warning with projection-owned severity', () => {
  const workspace = renderWorkspaceForNarrowerViewer(
    [
      {
        code: 'PAYMENT_SCHEDULE_REVIEW',
        severity: 'critical',
        message: 'Escalate this reviewer-authored payment note.',
        claimIds: ['claim_es_1']
      }
    ],
    CANONICAL_UNCONFIRMED_CLAIM
  );

  expect(workspace.generatedOutput?.content.warnings).toEqual([
    expect.objectContaining({
      severity: 'warning',
      message: CANONICAL_UNCONFIRMED_CLAIM,
      citationIds: [AUTHORIZED_EVIDENCE_ID]
    })
  ]);
});
