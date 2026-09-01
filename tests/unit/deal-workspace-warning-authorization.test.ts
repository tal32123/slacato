import type { AuthorizedDeal, Claim, DealBrief, DealEvidence, LatestDealRun } from '@slacato/core';
import { expect, it } from 'vitest';
import { renderDealWorkspace } from '../../apps/api/src/modules/deals/deal-workspace.mapper';

const AUTHORIZED_EVIDENCE_ID = 'salesforce:OPP-1:0';
const RESTRICTED_FACT = 'Board memo says the buyer will be acquired by Rival Corp for 40M.';

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

/** One evidence record the narrower viewer is authorized to read. */
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

/** Builds a claim citing only evidence the viewer is authorized to read. */
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

/**
 * A finalized brief whose claims all cite authorized evidence, so the generated output is
 * projected, plus review warnings with the three possible claim bindings.
 */
function briefWithWarnings(
  warnings: readonly unknown[],
  warningSubject = 'The renewal is progressing.'
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

/** Warning text a broad approver preserved or edited in, carrying no claim binding at all. */
const unboundWarning = {
  code: 'UNBOUND_REVIEWER_NOTE',
  severity: 'critical',
  message: RESTRICTED_FACT,
  claimIds: []
};

/** Warning bound to a claim whose citation the narrower viewer is authorized to read. */
const boundWarning = {
  code: 'BOUND_REVIEWER_NOTE',
  severity: 'warning',
  message: 'Confirm the renewal close date with the deal desk.',
  claimIds: ['claim_es_1']
};

/** Warning bound to a claim the validator dropped from the finalized brief. */
const danglingWarning = {
  code: 'INSUFFICIENT_CLAIM_SUPPORT',
  severity: 'warning',
  message: `Discarded claim reported: ${RESTRICTED_FACT}`,
  claimIds: ['claim_rejected_1']
};

function renderWorkspaceForNarrowerViewer(
  warnings: readonly unknown[],
  warningSubject = 'The renewal is progressing.'
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

it('withholds review-warning text that is not bound to a claim the viewer is authorized to read', () => {
  const workspace = renderWorkspaceForNarrowerViewer([unboundWarning, boundWarning]);

  // The generated output must actually be projected, or the assertions below pass vacuously.
  expect(workspace.generatedOutput).not.toBeNull();
  const content = workspace.generatedOutput?.content;
  expect(content?.warnings.map((warning) => warning.message)).not.toContain(RESTRICTED_FACT);
  expect(content?.sections.confidenceAndReviewWarnings.items).not.toContain(RESTRICTED_FACT);
  expect(JSON.stringify(workspace)).not.toContain(RESTRICTED_FACT);
});

it('withholds arbitrary warning metadata bound to a harmless authorized claim', () => {
  const workspace = renderWorkspaceForNarrowerViewer([unboundWarning, boundWarning]);
  const content = workspace.generatedOutput?.content;

  expect(content?.warnings).toEqual([]);
  expect(content?.sections.confidenceAndReviewWarnings.items).toEqual([]);
});

it('drops a warning that references a claim the finalized brief no longer contains', () => {
  const warnings = [danglingWarning, boundWarning];
  expect(() => renderWorkspaceForNarrowerViewer(warnings)).not.toThrow();
  const messages = renderWorkspaceForNarrowerViewer(warnings).generatedOutput?.content.warnings.map(
    (warning) => warning.message
  );
  expect(messages).not.toContain(`Discarded claim reported: ${RESTRICTED_FACT}`);
});

it('recognizes the canonical unconfirmed domain wording as a review concern', () => {
  const workspace = renderWorkspaceForNarrowerViewer(
    [
      {
        code: 'PAYMENT_SCHEDULE_REVIEW',
        severity: 'critical',
        message: 'Reviewer-authored prose is not authoritative.',
        claimIds: ['claim_es_1']
      }
    ],
    'Payment schedule is unconfirmed.'
  );

  expect(workspace.generatedOutput?.content.warnings).toEqual([
    expect.objectContaining({
      severity: 'warning',
      message: 'Payment schedule is unconfirmed.',
      citationIds: [AUTHORIZED_EVIDENCE_ID]
    })
  ]);
});
