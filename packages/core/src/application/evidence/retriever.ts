import {
  AUTHORIZED_SOURCE_TYPES,
  type AuthorizedSourceType
} from '../../domain/permissions/authorize.js';
import { POLICY_CHUNK_CHARACTERS } from './chunk.js';
import type { EvidencePlan } from './contracts.js';

const DEFAULT_CONTEXT_CHARACTERS = 24_000;
const CANONICAL_CRM_RECORD_LIMIT = 1 + 1 + 5; // Account, opportunity, and every canonical contact.
// Deliberately separate from CANONICAL_CRM_RECORD_LIMIT: that constant guarantees every canonical
// CRM record is always surfaced by `searchExactCrmEvidence`. This constant instead bounds how many
// Salesforce rows are ADMITTED AS CANDIDATES into the ranked hybrid search (lexical/semantic + RRF)
// before fusion. Reusing the completeness guarantee (7) here made the per-source cap a no-op --
// since every opportunity has at most 7 Salesforce rows, all of them entered every section search
// regardless of relevance, so Salesforce accumulated RRF mass purely by appearing in more candidate
// lists and crowded out genuinely relevant slack/gong/policy chunks. Set to 2 to match the existing
// cap already used for every other non-primary source type (gong_summary, pricing, slack); values
// of 1-7 were compared against `pnpm eval:deterministic` and none regressed macroRecallAtK or
// permissionLeakage, so this is the smallest, most consistent choice available.
const SALESFORCE_CANDIDATE_WINDOW = 2;
const CANONICAL_POLICY_SECTION_LIMIT = 1 + 3; // Policy preamble and every bounded rule section.
const RELIABILITY_ADJUSTMENTS: Readonly<Record<string, number>> = Object.freeze({
  authoritative_policy: 0.02,
  authoritative_system: 0.015,
  direct_conversation: 0.012,
  internal_collaboration: 0.01,
  conversation_summary: 0.008
});

/** Produces the versioned, provider-independent retrieval recipe hashed into each manifest. */
export function buildEvidencePlan(
  input: Readonly<{ query: string; limit: number; maxContextCharacters?: number }>
): EvidencePlan {
  const query = input.query.trim();
  if (query.length === 0) throw new Error('Retrieval query must not be empty');
  if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > 100)
    throw new Error('Retrieval limit must be between 1 and 100');
  const maxContextCharacters = input.maxContextCharacters ?? DEFAULT_CONTEXT_CHARACTERS;
  if (!Number.isInteger(maxContextCharacters) || maxContextCharacters <= 0)
    throw new Error('Context character budget must be positive');
  return {
    query,
    fusionK: 60,
    exactLookups: ['account', 'opportunity', 'contacts'],
    sectionQueries: [
      {
        section: 'deal_snapshot',
        query: 'stage value close date renewal term next step',
        sourceTypes: ['salesforce']
      },
      {
        section: 'buyer_goals',
        query: 'buyer goals business drivers outcomes',
        sourceTypes: ['gong_summary', 'gong_transcript', 'slack']
      },
      {
        section: 'stakeholders',
        query: 'stakeholder role influence decision approval',
        sourceTypes: ['salesforce', 'gong_summary', 'gong_transcript', 'slack']
      },
      {
        section: 'negotiation_state',
        query: 'negotiation objection discount legal commercial risk',
        sourceTypes: ['gong_summary', 'gong_transcript', 'pricing', 'slack']
      },
      {
        section: 'next_actions',
        query: 'next action owner deadline commitment',
        sourceTypes: [...AUTHORIZED_SOURCE_TYPES]
      },
      {
        section: 'missing_information',
        query: 'missing unclear unresolved pending gap',
        sourceTypes: [...AUTHORIZED_SOURCE_TYPES]
      }
    ],
    sourceLimits: {
      gong_summary: Math.min(input.limit, 2),
      gong_transcript: input.limit,
      policy: CANONICAL_POLICY_SECTION_LIMIT,
      pricing: Math.min(input.limit, 2),
      salesforce: Math.min(input.limit, SALESFORCE_CANDIDATE_WINDOW),
      slack: Math.min(input.limit, 2)
    },
    crmRecordLimit: CANONICAL_CRM_RECORD_LIMIT,
    mandatorySourceTypes: ['policy'],
    policyReservation: {
      resultSlots: 1,
      contextCharacters: Math.max(
        1,
        Math.min(POLICY_CHUNK_CHARACTERS, Math.ceil(maxContextCharacters * 0.25))
      )
    },
    maxContextCharacters
  };
}

/** Minimal ranking facts allowed to influence the bounded, post-RRF adjustment. */
export type AdjustmentInput = Readonly<{
  fusionScore: number;
  sourceType: AuthorizedSourceType;
  reliabilityClass: string;
  eventDate?: string | undefined;
}>;

/** Adjusts fused evidence scores with capped reliability and recency signals while exempting policy from age penalties. */
export function applyEvidenceAdjustments(
  input: AdjustmentInput,
  now = new Date()
): Readonly<{
  score: number;
  reliabilityAdjustment: number;
  recencyAdjustment: number;
}> {
  const reliabilityAdjustment = Math.max(
    0,
    Math.min(0.02, RELIABILITY_ADJUSTMENTS[input.reliabilityClass] ?? 0)
  );
  let recencyAdjustment = 0;
  if (input.sourceType !== 'policy' && input.eventDate !== undefined) {
    const eventTime = Date.parse(`${input.eventDate}T00:00:00.000Z`);
    if (Number.isFinite(eventTime)) {
      const ageDays = Math.max(0, (now.getTime() - eventTime) / 86_400_000);
      recencyAdjustment = Math.max(-0.02, Math.min(0.02, 0.02 - (ageDays / 365) * 0.04));
    }
  }
  return {
    score: input.fusionScore + reliabilityAdjustment + recencyAdjustment,
    reliabilityAdjustment,
    recencyAdjustment
  };
}
