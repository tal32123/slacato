import { exportBrief, formatEvidenceCitation } from '@slacato/core';
import { describe, expect, it } from 'vitest';

describe('citation format', () => {
  it('names the source file and stable source ID for every canonical source', () => {
    expect(formatEvidenceCitation('gong/gong_call_summaries.tsv#CALL-008#chunk-0')).toBe(
      'source=gong/gong_call_summaries.tsv, call_id=CALL-008'
    );
    expect(formatEvidenceCitation('gong/transcripts/OPP-1001_CALL-008.md#chunk-1')).toBe(
      'source=gong/transcripts/OPP-1001_CALL-008.md, call_id=CALL-008'
    );
    expect(formatEvidenceCitation('slack/account_team_updates.tsv#SLK-9002#chunk-0')).toBe(
      'source=slack/account_team_updates.tsv, update_id=SLK-9002'
    );
    expect(
      formatEvidenceCitation('salesforce/contacts.tsv#CON-3003/opportunity/OPP-1001#chunk-0')
    ).toBe('source=salesforce/contacts.tsv, contact_id=CON-3003');
    expect(formatEvidenceCitation('pricing/pricing_notes.tsv#PN-4004#chunk-0')).toBe(
      'source=pricing/pricing_notes.tsv, pricing_note_id=PN-4004'
    );
    expect(formatEvidenceCitation('policies/deal_desk_policy.md#chunk-2')).toBe(
      'source=policies/deal_desk_policy.md, policy_id=deal-desk-policy'
    );
  });

  it('renders exported brief citations in the same format the workspace shows', () => {
    const citation = {
      id: 'citation_slack',
      evidenceId: 'slack:SLK-9002:0',
      locator: 'slack/account_team_updates.tsv#SLK-9002#chunk-0'
    };
    const brief = {
      dealSnapshot: {
        accountName: 'Northstar Foods Cooperative',
        opportunityName: 'Global Access Renewal',
        stage: '6.0 Order Review',
        claims: [
          {
            id: 'claim_snapshot',
            statement: 'The account team still needs the final owner matrix.',
            confidence: 1,
            citations: [citation]
          }
        ]
      },
      executiveSummary: { narrative: 'The account team still needs the final owner matrix.' },
      buyerGoalsAndBusinessDrivers: {
        goals: ['Confirm the final owner matrix.'],
        businessDrivers: []
      },
      stakeholderMap: { stakeholders: [] },
      negotiationState: { currentState: 'Renewal terms remain open.', risks: [] },
      recommendedNextActions: { actions: [] },
      missingInformation: {
        items: [{ question: 'Who owns the rollout matrix?', whyItMatters: 'Rollout ownership is unconfirmed.' }]
      },
      sourceEvidence: {
        evidence: [
          {
            evidenceId: 'slack:SLK-9002:0',
            sourceType: 'slack',
            summary: 'The account team still needs the final owner matrix.',
            capturedAt: '2026-05-05T00:00:00.000Z',
            claims: []
          }
        ]
      },
      confidenceAndReviewWarnings: { overallConfidence: 1, warnings: [] }
    };

    const markdown = exportBrief(brief, 'markdown');

    expect(markdown).toContain('source=slack/account_team_updates.tsv, update_id=SLK-9002');
  });
});
