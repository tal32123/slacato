import type { AgentEvidenceRecord, DealBrief } from '@slacato/core';
import { buildEvidenceDocuments, chunkDocument } from '@slacato/core';
import { parseFixtureSet } from '../../scripts/fixture-loader.js';

/**
 * Shared fixtures for brief-quality and grounding tests.
 *
 * Evidence records come from the canonical fixture tree rather than from hand-written prose, so a
 * grounding assertion is made against exactly the text the ingest pipeline puts in front of an
 * agent. Hand-written evidence would let a validator defect hide behind conveniently phrased test
 * data.
 */

const fixtures = parseFixtureSet('fixtures/cato');
const chunks = buildEvidenceDocuments(fixtures).flatMap((document) => chunkDocument(document));

/** Deterministic citation identifier for a fixture chunk; shape only, never a real content hash. */
function citationIdFor(evidenceId: string): string {
  return `citation_${[...evidenceId].reduce((hash, character) => (hash * 31 + character.codePointAt(0)!) % 0xffffffff, 7).toString(16).padStart(8, '0')}`;
}

/** Builds the authorized evidence record an agent sees for one canonical fixture chunk. */
export function fixtureEvidence(evidenceId: string): AgentEvidenceRecord {
  const chunk = chunks.find((candidate) => candidate.id === evidenceId);
  if (chunk === undefined) throw new Error(`Unknown fixture evidence chunk: ${evidenceId}`);
  return {
    evidenceId: chunk.id,
    citationId: citationIdFor(chunk.id) as AgentEvidenceRecord['citationId'],
    content: chunk.content,
    contentHash: `hash_${chunk.id}`,
    sourceType: chunk.sourceType as AgentEvidenceRecord['sourceType'],
    sensitivity: chunk.accessLevel,
    sourceLocator: chunk.sourceLocator,
    classificationReason: chunk.classificationReason,
    policyHash: chunk.policyHash,
    ...(chunk.eventDate === undefined ? {} : { eventDate: chunk.eventDate }),
    reliabilityClass: chunk.reliability,
    fusionScore: 1,
    reliabilityAdjustment: 0,
    recencyAdjustment: 0,
    score: 1,
    rank: 1,
    accountId: chunk.accountId,
    opportunityId: chunk.opportunityId ?? 'OPP-1001'
  };
}

/** Builds the citation tuple a generated claim must copy verbatim for a fixture chunk. */
export function fixtureCitation(evidenceId: string) {
  const evidence = fixtureEvidence(evidenceId);
  return {
    id: evidence.citationId,
    evidenceId: evidence.evidenceId,
    locator: evidence.sourceLocator
  };
}

/** Builds a claim that copies one fixture citation tuple without altering it. */
export function fixtureClaim(id: string, statement: string, evidenceId: string) {
  return { id, statement, confidence: 1, citations: [fixtureCitation(evidenceId)] };
}

/** The five ACC-2001 contacts, with the exact wording their contact record states. */
export const NORTHSTAR_CONTACTS = [
  {
    contactId: 'CON-3001',
    name: 'Elena Voss',
    title: 'Chief Information Security Officer',
    role: 'economic_buyer',
    influence: 'high',
    relationship: 'positive',
    note: 'Wants a clean renewal path but will not support expansion unless regional exception handling is reduced.'
  },
  {
    contactId: 'CON-3002',
    name: 'Marco Devlin',
    title: 'VP Infrastructure',
    role: 'decision_maker',
    influence: 'high',
    relationship: 'positive',
    note: 'Owns branch migration plan and wants named escalation owners for rollout.'
  },
  {
    contactId: 'CON-3003',
    name: 'Iris Calder',
    title: 'Procurement Director',
    role: 'procurement',
    influence: 'medium',
    relationship: 'neutral',
    note: 'Focused on renewal uplift, payment schedule, and keeping final order form simple.'
  },
  {
    contactId: 'CON-3004',
    name: 'Pavel Stone',
    title: 'Global Network Lead',
    role: 'evaluator',
    influence: 'medium',
    relationship: 'positive',
    note: 'Advocates for reducing bypass exceptions but needs reporting on migration progress.'
  },
  {
    contactId: 'CON-3005',
    name: 'Amara Quinn',
    title: 'Legal Counsel',
    role: 'legal',
    influence: 'medium',
    relationship: 'neutral',
    note: 'Reviewing liability language and data processing addendum.'
  }
] as const;

/** The contact chunk identifier the ingest pipeline assigns to one ACC-2001 contact on OPP-1001. */
export function contactEvidenceId(contactId: string): string {
  return `salesforce:${contactId}:OPP-1001:contact:0`;
}

/** Builds the stakeholder entry a well-behaved agent produces for one canonical contact record. */
export function northstarStakeholder(contact: (typeof NORTHSTAR_CONTACTS)[number]) {
  const evidenceId = contactEvidenceId(contact.contactId);
  const slug = contact.contactId.toLocaleLowerCase('en-US').replace('-', '_');
  return {
    name: contact.name,
    title: contact.title,
    role: contact.role,
    influence: contact.influence,
    relationship: contact.relationship,
    goals: [contact.note],
    concerns: [contact.note],
    claims: [
      fixtureClaim(`claim_stk_${slug}`, `${contact.name} is ${contact.title}`, evidenceId),
      fixtureClaim(`claim_stk_${slug}_goal`, contact.note, evidenceId)
    ]
  };
}

/** A finalized brief that satisfies every brief-quality invariant, used as the control fixture. */
export function healthyBrief(): DealBrief {
  const contact = NORTHSTAR_CONTACTS[1];
  const contactEvidence = contactEvidenceId(contact.contactId);
  return {
    dealSnapshot: {
      accountName: 'Northstar Foods Cooperative',
      opportunityName: 'Northstar Foods Cooperative - Global Access Renewal',
      stage: '6.0 Order Review'
    },
    executiveSummary: {
      narrative: 'The renewal is progressing with the rollout model under review.',
      claims: [
        fixtureClaim(
          'claim_es_1',
          'The renewal is progressing with the rollout model under review.',
          contactEvidence
        )
      ]
    },
    buyerGoalsAndBusinessDrivers: {
      goals: [contact.note],
      businessDrivers: [contact.note],
      claims: [fixtureClaim('claim_bg_1', contact.note, contactEvidence)]
    },
    stakeholderMap: {
      stakeholders: [northstarStakeholder(contact)]
    },
    negotiationState: {
      currentState: 'Commercial terms are under review with the deal desk.',
      risks: ['Regional exception handling remains unresolved.'],
      claims: [
        fixtureClaim(
          'claim_ns_1',
          'Commercial terms are under review with the deal desk.',
          contactEvidence
        )
      ]
    },
    recommendedNextActions: {
      actions: [
        {
          action: 'Confirm the named escalation owners for the branch migration rollout.',
          priority: 'high',
          rationale: contact.note,
          claims: [fixtureClaim('claim_act_1', contact.note, contactEvidence)]
        }
      ]
    },
    missingInformation: {
      items: [
        {
          question: 'Confirm the migration success metrics with the account team.',
          whyItMatters: 'Additional information is required before the deal team can act.'
        }
      ]
    },
    sourceEvidence: {
      evidence: [
        {
          evidenceId: contactEvidence,
          sourceType: 'crm',
          summary: contact.note,
          capturedAt: '2026-04-18T00:00:00Z',
          claims: [fixtureClaim('claim_ev_1', contact.note, contactEvidence)]
        },
        {
          evidenceId: 'slack:SLK-9002:0',
          sourceType: 'slack',
          summary:
            'We still need the final owner matrix and success metrics confirmed by the client stakeholders.',
          capturedAt: '2026-05-05T00:00:00Z',
          claims: [
            fixtureClaim(
              'claim_ev_2',
              'We still need the final owner matrix and success metrics confirmed by the client stakeholders.',
              'slack:SLK-9002:0'
            )
          ]
        }
      ]
    },
    confidenceAndReviewWarnings: { overallConfidence: 0.9, warnings: [] }
  } as DealBrief;
}

/** Expectations matching the canonical OPP-1001 fixtures, for checker unit tests. */
export const NORTHSTAR_EXPECTATIONS = {
  contactsByEvidenceId: Object.fromEntries(
    NORTHSTAR_CONTACTS.map((contact) => [contactEvidenceId(contact.contactId), contact.name])
  ),
  reachableSourceTypes: ['crm', 'slack'],
  minimumSourceTypes: 2
} as const;
