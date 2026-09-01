import { describe, expect, it } from 'vitest';
import type { AgentEvidenceRecord, DealBrief } from '@slacato/core';
import { validateDealBrief, validateStakeholderArtifact } from '@slacato/core';
import { evaluateBriefQuality } from '../../scripts/brief-quality.js';
import {
  contactEvidenceId,
  fixtureClaim,
  fixtureEvidence,
  NORTHSTAR_CONTACTS,
  NORTHSTAR_EXPECTATIONS,
  northstarStakeholder
} from '../support/brief-fixtures.js';

/**
 * Grounding behaviour of the brief pipeline, exercised without a model or a database.
 *
 * The samples handed in as deliverables were produced by a live model, but the defects visible in
 * them are introduced afterwards, by the deterministic validation pass that prunes generated
 * content. That makes them reproducible here: the evidence is the canonical fixture text, and the
 * generated artifact is the shape a well-behaved agent produces from it. Every assertion below
 * describes the behaviour the brief pipeline must have, not the mechanism that delivers it.
 */

const MANIFEST_ID = 'manifest_grounding_fixture';
const CONTEXT = {
  account: { id: 'ACC-2001', name: 'Northstar Foods Cooperative' },
  opportunity: {
    id: 'OPP-1001',
    name: 'Northstar Foods Cooperative - Global Access Renewal',
    stage: '6.0 Order Review'
  }
};

const contactEvidence: readonly AgentEvidenceRecord[] = NORTHSTAR_CONTACTS.map((contact) =>
  fixtureEvidence(contactEvidenceId(contact.contactId))
);
const slackEvidence = fixtureEvidence('slack:SLK-9002:0');
const evidence = [...contactEvidence, slackEvidence];

/** The stakeholder artifact a well-behaved agent produces from the five ACC-2001 contact records. */
function stakeholderArtifact() {
  return {
    evidenceManifestId: MANIFEST_ID,
    stakeholders: NORTHSTAR_CONTACTS.map((contact) => northstarStakeholder(contact)),
    coverageGaps: [],
    claims: [],
    reviewWarnings: []
  };
}

/** A generated brief that maps every authorized contact and cites CRM plus Slack evidence. */
function generatedBrief(overrides: Partial<DealBrief> = {}) {
  const marco = NORTHSTAR_CONTACTS[1];
  const marcoEvidence = contactEvidenceId(marco.contactId);
  const slackStatement =
    'We still need the final owner matrix and success metrics confirmed by the client stakeholders.';
  return {
    dealSnapshot: {
      accountName: CONTEXT.account.name,
      opportunityName: CONTEXT.opportunity.name,
      stage: CONTEXT.opportunity.stage
    },
    executiveSummary: {
      narrative: marco.note,
      claims: [fixtureClaim('claim_es_1', marco.note, marcoEvidence)]
    },
    buyerGoalsAndBusinessDrivers: {
      goals: [marco.note],
      businessDrivers: [],
      claims: [fixtureClaim('claim_bg_1', marco.note, marcoEvidence)]
    },
    stakeholderMap: {
      stakeholders: NORTHSTAR_CONTACTS.map((contact) => northstarStakeholder(contact))
    },
    negotiationState: {
      currentState: marco.note,
      risks: [slackStatement],
      claims: [
        fixtureClaim('claim_ns_1', marco.note, marcoEvidence),
        fixtureClaim('claim_ns_2', slackStatement, 'slack:SLK-9002:0')
      ]
    },
    recommendedNextActions: {
      actions: [
        { action: 'Confirm the final owner matrix with the account team.', audience: 'internal', priority: 'high', rationale: slackStatement,
        claims: [fixtureClaim('claim_act_1', slackStatement, 'slack:SLK-9002:0')] }
      ]
    },
    missingInformation: { items: [] },
    sourceEvidence: {
      evidence: [
        {
          evidenceId: marcoEvidence,
          sourceType: 'crm',
          summary: marco.note,
          capturedAt: '2026-04-18T00:00:00Z',
          claims: [fixtureClaim('claim_ev_1', marco.note, marcoEvidence)]
        },
        {
          evidenceId: 'slack:SLK-9002:0',
          sourceType: 'slack',
          summary: slackStatement,
          capturedAt: '2026-05-05T00:00:00Z',
          claims: [fixtureClaim('claim_ev_2', slackStatement, 'slack:SLK-9002:0')]
        }
      ]
    },
    confidenceAndReviewWarnings: { overallConfidence: 0.9, warnings: [] },
    ...overrides
  };
}

describe('stakeholder grounding', () => {
  it('keeps every stakeholder whose name and title one authorized contact record states', () => {
    const result = validateStakeholderArtifact(stakeholderArtifact(), MANIFEST_ID, evidence);
    expect(result.stakeholders.map((stakeholder) => stakeholder.name)).toEqual(
      NORTHSTAR_CONTACTS.map((contact) => contact.name)
    );
  });

  it('records no unsupported-record coverage gap when every generated record is supported', () => {
    const result = validateStakeholderArtifact(stakeholderArtifact(), MANIFEST_ID, evidence);
    expect(result.coverageGaps).not.toContain('Verify unsupported stakeholder records.');
  });

  it('never puts an internal claim identifier into a coverage gap the reviewer reads', () => {
    const result = validateStakeholderArtifact(stakeholderArtifact(), MANIFEST_ID, evidence);
    for (const gap of result.coverageGaps) expect(gap).not.toMatch(/\bclaim_[A-Za-z0-9_-]+/u);
  });
});

describe('deal brief grounding', () => {
  it('keeps every stakeholder the authorized contact records support', () => {
    const brief = validateDealBrief(generatedBrief(), evidence, CONTEXT);
    expect(brief.stakeholderMap.stakeholders.map((stakeholder) => stakeholder.name)).toEqual(
      NORTHSTAR_CONTACTS.map((contact) => contact.name)
    );
  });

  it('leaves an already-grounded brief untouched when it is grounded again', () => {
    // edit_and_approve re-runs this validator over the payload the approver submitted and refuses
    // the decision unless the result hashes identically -- that is what stops an approver
    // smuggling ungrounded claims into an approved brief. The check is only usable because
    // grounding is a fixed point: every persisted approval subject is itself validator output, so
    // re-grounding an unedited section has to return it byte-for-byte. A normalization that only
    // applies on the first pass (capturedAt is stamped this way) would make every "Edit and
    // approve" click fail with a 400 while every other test still passed.
    const grounded = validateDealBrief(generatedBrief(), evidence, CONTEXT);
    expect(validateDealBrief(grounded, evidence, CONTEXT)).toEqual(grounded);
  });

  it('lets retrieved Slack account-team updates reach Source Evidence', () => {
    const brief = validateDealBrief(generatedBrief(), evidence, CONTEXT);
    expect(brief.sourceEvidence.evidence.map((entry) => entry.sourceType)).toContain('slack');
  });

  it('populates every required section for the authorized happy-path deal', () => {
    const brief = validateDealBrief(generatedBrief(), evidence, CONTEXT);
    expect({
      stakeholders: brief.stakeholderMap.stakeholders.length,
      actions: brief.recommendedNextActions.actions.length,
      risks: brief.negotiationState.risks.length,
      evidence: brief.sourceEvidence.evidence.length
    }).toEqual({ stakeholders: 5, actions: 1, risks: 1, evidence: 2 });
  });

  it('never asks the reviewer to verify an internal claim identifier', () => {
    const brief = validateDealBrief(generatedBrief(), evidence, CONTEXT);
    for (const item of brief.missingInformation.items) {
      expect(item.question).not.toMatch(/\bclaim_[A-Za-z0-9_-]+/u);
      expect(item.whyItMatters).not.toMatch(/\bclaim_[A-Za-z0-9_-]+/u);
    }
  });

  it('describes a genuinely unsupported claim in words the reviewer can act on', () => {
    // A rejected claim must still produce readable follow-up. Naming the discarded claim by its
    // internal id tells the reviewer nothing: the id is gone from the brief they are holding.
    const marco = NORTHSTAR_CONTACTS[1];
    const hallucinated = generatedBrief({
      negotiationState: {
        currentState: marco.note,
        risks: ['The customer has already signed a three-year renewal at list price.'],
        claims: [
          fixtureClaim('claim_ns_1', marco.note, contactEvidenceId(marco.contactId)),
          fixtureClaim(
            'claim_ns_hallucinated',
            'The customer has already signed a three-year renewal at list price.',
            contactEvidenceId(marco.contactId)
          )
        ]
      }
    } as Partial<DealBrief>);
    const brief = validateDealBrief(hallucinated, evidence, CONTEXT);
    expect(brief.missingInformation.items.length).toBeGreaterThan(0);
    for (const item of brief.missingInformation.items) {
      expect(item.question).not.toMatch(/\bclaim_[A-Za-z0-9_-]+/u);
      expect(item.whyItMatters).not.toMatch(/\bclaim_[A-Za-z0-9_-]+/u);
    }
  });

  it('drops a stale support warning that names a stakeholder the brief presents as supported', () => {
    const amara = NORTHSTAR_CONTACTS[4];
    const brief = validateDealBrief(
      generatedBrief({
        confidenceAndReviewWarnings: {
          overallConfidence: 0.9,
          warnings: [
            {
              code: 'INSUFFICIENT_CLAIM_SUPPORT',
              severity: 'warning',
              message: `Material anchors are absent: ${amara.title.toLocaleLowerCase('en-US')} ${amara.name.toLocaleLowerCase('en-US')}`,
              claimIds: []
            }
          ]
        }
      } as Partial<DealBrief>),
      evidence,
      CONTEXT
    );
    const named = brief.confidenceAndReviewWarnings.warnings.filter((warning) =>
      warning.message.toLocaleLowerCase('en-US').includes(amara.name.toLocaleLowerCase('en-US'))
    );
    expect(named).toEqual([]);
  });

  it('produces a brief that satisfies every brief-quality invariant end to end', () => {
    const brief = validateDealBrief(generatedBrief(), evidence, CONTEXT);
    expect(evaluateBriefQuality(brief, NORTHSTAR_EXPECTATIONS).violations).toEqual([]);
  });
});
