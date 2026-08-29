import { createHash } from 'node:crypto';
import type {
  Claim,
  CommercialArtifact,
  ConversationArtifact,
  DealBrief,
  ReviewWarning,
  StakeholderArtifact
} from '../../domain/briefs/schema.js';
import {
  commercialArtifactSchema,
  conversationArtifactSchema,
  dealBriefSchema,
  MAX_LIST_ITEMS,
  stakeholderArtifactSchema
} from '../../domain/briefs/schema.js';
import { DomainValidationError } from '../../domain/shared/errors.js';
import { accountIdSchema, opportunityIdSchema, runIdSchema } from '../../domain/shared/ids.js';
import { createEvidenceScopeBinding, hashEvidenceScopeBinding } from '../evidence/scope-binding.js';
import type { AgentContext, AgentEvidenceRecord } from './contracts.js';

export type ClaimSupport = 'supported' | 'contradicted' | 'insufficient';
export type ClaimSupportAssessment = Readonly<{
  claimId: string;
  support: ClaimSupport;
  reason: string;
}>;

/** Normalizes evidence text for deterministic, case-insensitive comparisons. */
function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

/** Rejects generated prose that resembles instructions or prompt-control markers. */
function safeGeneratedProse(value: string): boolean {
  return !/(?:BEGIN|END)_UNTRUSTED|\b[A-Z0-9]+_SENTINEL\b|ignore (?:all |the |any )?(?:previous|prior|system)|system prompt|(?:call|invoke|use) (?:a |the )?tool|role\s*:/i.test(
    value
  );
}

/** Escapes literal evidence text before using it in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Checks whether a complete word or number appears in normalized evidence text. */
function containsBounded(haystack: string, needle: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(
    haystack
  );
}

/** Extracts material names, dates, amounts, quoted text, and business terms from a claim. */
function materialAnchors(statement: string): readonly string[] {
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?\b/gu,
    /(?:[$€£]\s*)?\b\d[\d,.]*(?:\s*%)?/gu,
    /\b[A-Z]{3}\b/gu,
    /["“]([^"“”]{3,120})["”]/gu,
    /\b(?:liability|indemnity|termination|renewal|governing law|data processing|service level|discount|competitor)\b/giu,
    /\b(?:competitor|stakeholder|buyer|approver)\s+(?:is\s+)?([A-Z][\p{L}\p{N}.-]*(?:\s+[A-Z][\p{L}\p{N}.-]*){0,3})/gu,
    /\b([A-Z][\p{L}\p{N}.-]+(?:\s+[A-Z][\p{L}\p{N}.-]+){1,3})\b/gu
  ];
  const anchors = new Set<string>();
  for (const pattern of patterns) {
    for (const match of statement.matchAll(pattern)) {
      const anchor = (match[1] ?? match[0]).trim();
      if (anchor.length > 0) anchors.add(normalize(anchor));
    }
  }
  return [...anchors];
}

const SUPPORT_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'before',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with'
]);

/** Reduces common word endings so related evidence terms compare consistently. */
function stem(value: string): string {
  if (value.length > 5 && value.endsWith('ing')) return value.slice(0, -3);
  if (value.length > 4 && value.endsWith('ied')) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && value.endsWith('ed')) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith('es')) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith('s')) return value.slice(0, -1);
  return value;
}

/** Extracts the meaningful normalized terms used to relate a claim to evidence. */
function supportTerms(value: string): ReadonlySet<string> {
  return new Set(
    normalize(value)
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length > 2 && !SUPPORT_STOP_WORDS.has(term))
      .map(stem) ?? []
  );
}

const MATERIAL_PREDICATES = [
  {
    assertion: /\beconomic buyer\b/i,
    evidence: /\b(?:economic buyer|controls? (?:the )?budget|final (?:purchasing )?decision)\b/i
  },
  {
    assertion: /\bhigh influence\b/i,
    evidence: /\b(?:high influence|controls? (?:the )?budget|final (?:purchasing )?decision)\b/i
  },
  {
    assertion: /\bpositive relationship\b/i,
    evidence: /\b(?:positive relationship|supportive|advocates?|champion)\b/i
  },
  { assertion: /\blegal review\b/i, evidence: /\b(?:legal review|legal approval)\b/i },
  { assertion: /\brequired\b/i, evidence: /\b(?:required|must)\b/i },
  { assertion: /\bapproved\b/i, evidence: /\b(?:approved|authorized)\b/i },
  { assertion: /\baccepted\b/i, evidence: /\b(?:accepted|agreed)\b/i },
  { assertion: /\brejected\b/i, evidence: /\b(?:rejected|declined)\b/i },
  { assertion: /\bunlimited\b/i, evidence: /\bunlimited\b/i },
  { assertion: /\bcapped\b/i, evidence: /\b(?:capped|limited)\b/i },
  { assertion: /\bcommit(?:s|ted)?\b/i, evidence: /\bcommit(?:s|ted)?\b/i },
  { assertion: /\binclude(?:s|d)?\b/i, evidence: /\binclude(?:s|d)?\b/i },
  { assertion: /\bexclude(?:s|d)?\b/i, evidence: /\bexclude(?:s|d)?\b/i },
  { assertion: /\boppos(?:e|es|ed)\b/i, evidence: /\boppos(?:e|es|ed)\b/i },
  {
    assertion: /\bsupport(?:s|ed)?\b/i,
    evidence: /\b(?:support(?:s|ed)?|need(?:s|ed)?|require(?:s|d)?)\b/i
  }
] as const;

/** Normalizes a complete assertion while ignoring spacing and terminal punctuation. */
function normalizedAssertion(value: string): string {
  return normalize(value)
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/u, '')
    .trim();
}

/** Recognizes the one supported transformation from budget control to economic-buyer status. */
function explicitStakeholderClassificationSupported(assertion: string, support: string): boolean {
  const match = /^(.+?) is (?:the )?economic buyer with high influence$/u.exec(
    normalizedAssertion(assertion)
  );
  if (match?.[1] === undefined) return false;
  const subject = escapeRegExp(match[1]);
  return new RegExp(
    `^${subject} controls? (?:the )?budget and makes? (?:the )?final purchasing decision$`,
    'u'
  ).test(normalizedAssertion(support));
}

/** Removes a code-owned field label from structured fixture evidence. */
function structuredFieldValue(value: string): string | undefined {
  return /^[a-z][A-Za-z0-9]*:\s+(.+)$/su.exec(value.trim())?.[1];
}

/** Matches an assertion to structured fixture evidence while ignoring its code-owned label. */
function structuredFieldAssertionSupported(assertion: string, support: string): boolean {
  const fieldValue = structuredFieldValue(support);
  if (fieldValue === undefined) return false;
  const withoutLeadingArticle = (value: string): string =>
    normalizedAssertion(value).replace(/^the\s+/u, '');
  return withoutLeadingArticle(assertion) === withoutLeadingArticle(fieldValue);
}

/** Accepts exact local support plus one tightly bounded stakeholder-classification transformation. */
function textAtomsSupported(assertion: string, support: string): boolean {
  if (!safeGeneratedProse(assertion)) return false;
  return (
    normalizedAssertion(assertion) === normalizedAssertion(support) ||
    structuredFieldAssertionSupported(assertion, support) ||
    explicitStakeholderClassificationSupported(assertion, support)
  );
}

/** Extracts the subject terms that must connect an assertion to one evidence unit. */
function relationTerms(assertion: string): ReadonlySet<string> {
  const withoutPredicates = MATERIAL_PREDICATES.reduce(
    (value, predicate) => value.replace(predicate.assertion, ' '),
    assertion
  )
    .replace(POSITIVE_INTENT, ' ')
    .replace(NEGATIVE_INTENT, ' ')
    .replace(/\b(?:not|never|no longer|cannot|can't|won't|doesn't|didn't)\b/gi, ' ');
  return supportTerms(withoutPredicates);
}

/** Confirms that one evidence unit contains every subject term from an assertion. */
function unitRelatesToAssertion(assertion: string, unit: string): boolean {
  const terms = relationTerms(assertion);
  if (terms.size === 0)
    return materialAnchors(assertion).some((anchor) => containsBounded(normalize(unit), anchor));
  const unitTerms = supportTerms(unit);
  return [...terms].every((term) => unitTerms.has(term));
}

/** Splits cited evidence into the individual statements used for support checks. */
function evidenceUnits(evidence: readonly AgentEvidenceRecord[]): readonly string[] {
  return evidence.flatMap((record) =>
    record.content
      .split(/\n+|(?<=[.!?])\s+/u)
      .map((unit) => unit.trim())
      .filter(Boolean)
  );
}

/** Detects whether nearby evidence language explicitly negates a material claim anchor. */
function explicitlyNegates(content: string, anchor: string): boolean {
  const normalized = normalize(content);
  const match = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(anchor)}(?![\\p{L}\\p{N}])`,
    'u'
  ).exec(normalized);
  const at = match?.index ?? -1;
  if (at < 0) return false;
  const prefix = normalized.slice(Math.max(0, at - 80), at);
  return /\b(?:not|no|never|denied|declined|rejected|without)\b/.test(prefix);
}

const CONTRADICTORY_PREDICATES = [
  ['accepted', 'rejected'],
  ['approved', 'denied'],
  ['approved', 'rejected'],
  ['agreed', 'declined'],
  ['required', 'optional'],
  ['unlimited', 'capped'],
  ['unlimited', 'limited'],
  ['increased', 'decreased'],
  ['positive', 'negative'],
  ['includes', 'excludes'],
  ['included', 'excluded'],
  ['allows', 'prohibits'],
  ['enabled', 'disabled'],
  ['present', 'absent'],
  ['available', 'unavailable'],
  ['won', 'lost']
] as const;

const POSITIVE_INTENT =
  /\b(?:need(?:s|ed)?|want(?:s|ed)?|support(?:s|ed)?|prefer(?:s|red)?|accept(?:s|ed)?|approv(?:e|es|ed)|agree(?:s|d)?|request(?:s|ed)?|commit(?:s|ted)?|advocat(?:e|es|ed)|endors(?:e|es|ed)|allow(?:s|ed)?|include(?:s|d)?|enable(?:s|d)?|require(?:s|d)?)\b/i;
const NEGATIVE_INTENT =
  /\b(?:oppos(?:e|es|ed)|reject(?:s|ed)?|refus(?:e|es|ed)|declin(?:e|es|ed)|object(?:s|ed)?|resist(?:s|ed)?|block(?:s|ed)?|den(?:y|ies|ied)|avoid(?:s|ed)?|cancel(?:s|led)?|prohibit(?:s|ed)?|exclude(?:s|d)?|disable(?:s|d)?)\b/i;
const NEGATED_MATERIAL_PREDICATE =
  /\b(?:not|never|no longer|cannot|can't|won't|doesn't|didn't)\b(?:\s+\S+){0,3}\s+(?:need|want|support|prefer|accept|approve|agree|request|commit|allow|include|enable|require)\w*\b/i;

/** Detects opposing intent or business predicates between a claim and its evidence. */
function hasPredicateContradiction(statement: string, evidence: string): boolean {
  const normalizedStatement = normalize(statement);
  const normalizedEvidence = normalize(evidence);
  const statementPositive = POSITIVE_INTENT.test(statement);
  const statementNegative = NEGATIVE_INTENT.test(statement);
  const evidencePositive = POSITIVE_INTENT.test(evidence);
  const evidenceNegative = NEGATIVE_INTENT.test(evidence);
  if (
    (statementPositive && !statementNegative && evidenceNegative && !evidencePositive) ||
    (statementNegative && !statementPositive && evidencePositive && !evidenceNegative)
  )
    return true;
  if (
    NEGATED_MATERIAL_PREDICATE.test(statement) !== NEGATED_MATERIAL_PREDICATE.test(evidence) &&
    (POSITIVE_INTENT.test(statement) || POSITIVE_INTENT.test(evidence))
  )
    return true;
  if (
    /\bnot required\b/.test(normalizedStatement) &&
    /\brequired\b/.test(normalizedEvidence) &&
    !/\bnot required\b/.test(normalizedEvidence)
  )
    return true;
  if (
    /\brequired\b/.test(normalizedStatement) &&
    !/\bnot required\b/.test(normalizedStatement) &&
    /\bnot required\b/.test(normalizedEvidence)
  )
    return true;
  return CONTRADICTORY_PREDICATES.some(
    ([left, right]) =>
      (containsBounded(normalizedStatement, left) && containsBounded(normalizedEvidence, right)) ||
      (containsBounded(normalizedStatement, right) && containsBounded(normalizedEvidence, left))
  );
}

/** Resolves every claim citation to its exact authorized evidence record. */
function findEvidence(
  claim: Claim,
  evidenceById: ReadonlyMap<string, AgentEvidenceRecord>
): readonly AgentEvidenceRecord[] {
  if (claim.citations.length === 0) return [];
  return claim.citations.map((citation) => {
    const evidence = evidenceById.get(citation.evidenceId);
    if (
      evidence === undefined ||
      evidence.citationId !== citation.id ||
      evidence.sourceLocator !== citation.locator
    ) {
      throw new DomainValidationError('Unknown or stale citation in generated claim', {
        claimId: claim.id
      });
    }
    return evidence;
  });
}

/** Determines whether a claim is supported, contradicted, or insufficiently grounded by its cited evidence. */
export function assessClaimSupport(
  claim: Claim,
  evidenceById: ReadonlyMap<string, AgentEvidenceRecord>
): ClaimSupportAssessment {
  if (!safeGeneratedProse(claim.statement))
    return {
      claimId: claim.id,
      support: 'insufficient',
      reason: 'Claim contains unsafe instruction-like prose.'
    };
  const citedEvidence = findEvidence(claim, evidenceById);
  if (citedEvidence.length === 0)
    return {
      claimId: claim.id,
      support: 'insufficient',
      reason: 'Claim has no authorized citations.'
    };
  const anchors = materialAnchors(claim.statement);
  const units = evidenceUnits(citedEvidence);
  const combined = normalize(citedEvidence.map((record) => record.content).join('\n'));
  if (
    units.some(
      (unit) =>
        unitRelatesToAssertion(claim.statement, unit) &&
        (hasPredicateContradiction(claim.statement, unit) ||
          anchors.some((anchor) => explicitlyNegates(unit, anchor)))
    )
  ) {
    return {
      claimId: claim.id,
      support: 'contradicted',
      reason: 'Cited evidence explicitly negates a material anchor.'
    };
  }
  const missing = anchors.filter((anchor) => !containsBounded(combined, anchor));
  if (missing.length > 0)
    return {
      claimId: claim.id,
      support: 'insufficient',
      reason: `Material anchors are absent: ${missing.join(', ')}`
    };
  if (!units.some((unit) => textAtomsSupported(claim.statement, unit)))
    return {
      claimId: claim.id,
      support: 'insufficient',
      reason: 'No single cited evidence unit supports the complete material relation.'
    };
  return {
    claimId: claim.id,
    support: 'supported',
    reason: 'All material anchors occur in authorized cited evidence.'
  };
}

/** Rejects generated artifacts that reuse a claim identifier. */
function assertUniqueClaims(claimGroups: readonly (readonly Claim[])[]): void {
  const seen = new Set<string>();
  for (const claim of claimGroups.flat()) {
    if (seen.has(claim.id))
      throw new DomainValidationError('Duplicate claim ID in generated artifact', {
        claimId: claim.id
      });
    seen.add(claim.id);
  }
}

type RejectedClaim = Readonly<{ claim: Claim; assessment: ClaimSupportAssessment }>;

/** Retains supported claims, rejects contradictions, and records claims that need review. */
function pruneClaims(
  claims: readonly Claim[],
  evidenceById: ReadonlyMap<string, AgentEvidenceRecord>
): Readonly<{ kept: readonly Claim[]; insufficient: readonly RejectedClaim[] }> {
  const kept: Claim[] = [];
  const insufficient: RejectedClaim[] = [];
  for (const claim of claims) {
    const assessment = assessClaimSupport(claim, evidenceById);
    if (assessment.support === 'contradicted')
      throw new DomainValidationError('Contradicted claim in generated artifact', {
        claimId: claim.id,
        reason: assessment.reason
      });
    if (assessment.support === 'supported')
      kept.push({
        ...claim,
        citations: claim.citations.map((citation) => ({
          id: citation.id,
          evidenceId: citation.evidenceId,
          locator: citation.locator
        }))
      });
    else insufficient.push({ claim, assessment });
  }
  return { kept, insufficient };
}

/** Converts unsupported claim assessments into actionable review warnings. */
function supportWarnings(claims: readonly RejectedClaim[]): readonly ReviewWarning[] {
  return claims.map(({ assessment, claim }) => ({
    code: 'INSUFFICIENT_CLAIM_SUPPORT',
    severity: 'warning',
    message: assessment.reason,
    claimIds: [claim.id]
  }));
}

/** Keeps generated warnings in order while adding required local warnings within schema limits. */
function mergeReviewWarnings(
  generated: readonly ReviewWarning[],
  deterministic: readonly ReviewWarning[],
  validClaimIds: ReadonlySet<string>
): readonly ReviewWarning[] {
  const merged: ReviewWarning[] = [];
  const indexes = new Map<string, number>();
  const deterministicKeys = new Set(
    deterministic.map(
      (warning) => `${warning.code}\u0000${warning.severity}\u0000${warning.message}`
    )
  );

  for (const [warning, preserveRejectedClaimIds] of [
    ...generated
      .filter((warning) => safeGeneratedProse(warning.message))
      .map((warning) => [warning, false] as const),
    ...deterministic.map((warning) => [warning, true] as const)
  ]) {
    const key = `${warning.code}\u0000${warning.severity}\u0000${warning.message}`;
    const claimIds = [
      ...new Set(
        warning.claimIds.filter((claimId) => preserveRejectedClaimIds || validClaimIds.has(claimId))
      )
    ].slice(0, MAX_LIST_ITEMS);
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, merged.length);
      merged.push({ ...warning, claimIds });
      continue;
    }

    const existing = merged[existingIndex];
    if (existing === undefined)
      throw new DomainValidationError('Merged review warning index is out of bounds');
    merged[existingIndex] = {
      ...existing,
      claimIds: [...new Set([...existing.claimIds, ...claimIds])].slice(0, MAX_LIST_ITEMS)
    };
  }

  while (merged.length > MAX_LIST_ITEMS) {
    let removableIndex = -1;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const warning = merged[index];
      if (warning === undefined)
        throw new DomainValidationError('Merged review warning index is out of bounds');
      const key = `${warning.code}\u0000${warning.severity}\u0000${warning.message}`;
      if (!deterministicKeys.has(key)) {
        removableIndex = index;
        break;
      }
    }
    merged.splice(removableIndex < 0 ? merged.length - 1 : removableIndex, 1);
  }
  return merged;
}

/** Indexes authorized evidence by its stable evidence identifier. */
function evidenceMap(
  evidence: readonly AgentEvidenceRecord[]
): ReadonlyMap<string, AgentEvidenceRecord> {
  return new Map(evidence.map((record) => [record.evidenceId, record]));
}

/** Confirms that a complete assertion is supported by at least one retained claim. */
function assertionSupported(assertion: string, claims: readonly Claim[]): boolean {
  return claims.some((claim) => textAtomsSupported(assertion, claim.statement));
}

/** Confirms that a generated field value appears in at least one retained claim. */
function fieldSupported(value: string | number, claims: readonly Claim[]): boolean {
  const normalized = normalize(String(value));
  return (
    safeGeneratedProse(String(value)) &&
    claims.some((claim) => containsBounded(normalize(claim.statement), normalized))
  );
}

/** Confirms that one retained claim supports every value in a generated record. */
function tupleSupported(values: readonly (string | number)[], claims: readonly Claim[]): boolean {
  return claims.some((claim) => values.every((value) => fieldSupported(value, [claim])));
}

/** Recognizes approved language that explicitly communicates evidence uncertainty. */
function isExplicitUncertainty(value: string): boolean {
  if (!safeGeneratedProse(value)) return false;
  return /^(?:unknown|unverified|not (?:available|known|verified)|requires? (?:review|verification)|hypothesis|no verified (?:summary|information) is available yet|insufficient verified information|insufficient (?:supported )?evidence is available(?: for (?:an executive summary|a negotiation-state assessment))?)\.?$/i.test(
    value.trim()
  );
}

/** Accepts only bounded, non-factual questions for gathering missing deal information. */
function safeInformationRequest(value: string): boolean {
  if (!safeGeneratedProse(value)) return false;
  const normalized = value.trim();
  if (
    /\b(?:after|because|given|that|according to|already|definitely|certainly)\b/i.test(normalized)
  )
    return false;
  const prefix = '(?:clarify|determine|confirm|verify|check)';
  const approvedDiscount = new RegExp(
    `^${prefix} whether (?:a|the) \\d+(?:\\.\\d+)?% discount is approved[.?]$`,
    'i'
  );
  const procurementApproval = new RegExp(
    `^${prefix} whether procurement approval is required[.?]$`,
    'i'
  );
  const procurementAttendance = new RegExp(
    `^${prefix} whether procurement must attend (?:a|the) workshop[.?]$`,
    'i'
  );
  const workshopScheduling = new RegExp(
    `^${prefix} whether (?:a|the) technical workshop should be scheduled[.?]$`,
    'i'
  );
  const reviewRequirement = new RegExp(
    `^${prefix} whether (?:legal|security|technical|commercial) review is required[.?]$`,
    'i'
  );
  const neutralIdentification =
    /^identify (?:who (?:can coordinate a technical workshop|represents procurement)|what (?:the next step|open questions) (?:is|are)|which (?:team|role) should respond)[.?]$/i;
  return (
    approvedDiscount.test(normalized) ||
    procurementApproval.test(normalized) ||
    procurementAttendance.test(normalized) ||
    workshopScheduling.test(normalized) ||
    reviewRequirement.test(normalized) ||
    neutralIdentification.test(normalized)
  );
}

/** Accepts only bounded internal workflow actions that make no customer-facing promise. */
function safeRecommendationAction(value: string): boolean {
  if (
    !safeGeneratedProse(value) ||
    /\b(?:promise|guarantee|bypass|conceal|mislead|fabricate)\b/i.test(value)
  )
    return false;
  const normalized = value.trim();
  const boundedMeeting =
    /^(?:schedule|arrange) (?:a|an|the) (?:technical )?(?:workshop|meeting|review|follow-up|call)(?: to (?:review|discuss|clarify|address|confirm|coordinate) (?:open questions|technical requirements|commercial requirements|next steps))?\.?$/i;
  const boundedPreparation =
    /^(?:prepare|document|review|validate) (?:a|an|the) (?:agenda|question list|evidence summary|deal brief|open issues)\.?$/i;
  const boundedCoordination =
    /^(?:follow up|coordinate) with (?:the )?(?:buyer|account executive|sales engineer|legal|procurement|deal owner)\.?$/i;
  const boundedEscalation = /^escalate to (?:legal|procurement|the deal owner)\.?$/i;
  return (
    boundedMeeting.test(normalized) ||
    boundedPreparation.test(normalized) ||
    boundedCoordination.test(normalized) ||
    boundedEscalation.test(normalized) ||
    safeInformationRequest(normalized)
  );
}

/** Accepts only generic internal roles that do not require factual evidence. */
function safeGenericOwner(value: string): boolean {
  return /^(?:account executive|sales engineer|legal|procurement|deal owner|unassigned)$/i.test(
    value.trim()
  );
}

/** Removes internal rejected-claim bookkeeping before returning a validated artifact. */
function withoutInsufficient<Value extends Readonly<{ insufficient: readonly unknown[] }>>(
  value: Value
): Omit<Value, 'insufficient'> {
  const { insufficient, ...copy } = value;
  void insufficient;
  return copy;
}

/** Removes unsupported conversation content without discarding valid model review warnings. */
export function validateConversationArtifact(
  value: unknown,
  manifestId: string,
  evidence: readonly AgentEvidenceRecord[]
): ConversationArtifact {
  const parsed = conversationArtifactSchema.parse(value);
  if (parsed.evidenceManifestId !== manifestId)
    throw new DomainValidationError('Conversation artifact evidence manifest does not match');
  assertUniqueClaims([parsed.claims]);
  const result = pruneClaims(parsed.claims, evidenceMap(evidence));
  const unsupportedAssertions = [
    parsed.goals,
    parsed.concerns,
    parsed.commitments,
    parsed.objections
  ]
    .flat()
    .filter((assertion) => !assertionSupported(assertion, result.kept));
  const warnings = supportWarnings(result.insufficient);
  const validClaimIds = new Set(result.kept.map((claim) => claim.id));
  return conversationArtifactSchema.parse({
    ...parsed,
    goals: parsed.goals.filter((assertion) => assertionSupported(assertion, result.kept)),
    concerns: parsed.concerns.filter((assertion) => assertionSupported(assertion, result.kept)),
    commitments: parsed.commitments.filter((assertion) =>
      assertionSupported(assertion, result.kept)
    ),
    objections: parsed.objections.filter((assertion) => assertionSupported(assertion, result.kept)),
    claims: result.kept,
    missingContext: [
      ...parsed.missingContext.filter(safeInformationRequest),
      ...result.insufficient.map(
        ({ assessment }) => `Verify evidence for claim ${assessment.claimId}.`
      ),
      ...(unsupportedAssertions.length === 0 ? [] : ['Verify unsupported conversation details.'])
    ],
    reviewWarnings: mergeReviewWarnings(parsed.reviewWarnings, warnings, validClaimIds)
  });
}

/** Removes unsupported stakeholder content without discarding valid model review warnings. */
export function validateStakeholderArtifact(
  value: unknown,
  manifestId: string,
  evidence: readonly AgentEvidenceRecord[]
): StakeholderArtifact {
  const parsed = stakeholderArtifactSchema.parse(value);
  if (parsed.evidenceManifestId !== manifestId)
    throw new DomainValidationError('Stakeholder artifact evidence manifest does not match');
  assertUniqueClaims([
    parsed.claims,
    ...parsed.stakeholders.map((stakeholder) => stakeholder.claims)
  ]);
  const map = evidenceMap(evidence);
  const top = pruneClaims(parsed.claims, map);
  const stakeholders = parsed.stakeholders.map((stakeholder) => {
    const claims = pruneClaims(stakeholder.claims, map);
    return { ...stakeholder, claims: claims.kept, insufficient: claims.insufficient };
  });
  const supportedStakeholders = stakeholders.flatMap((stakeholder) => {
    const role = stakeholder.role.replaceAll('_', ' ');
    const identity = [
      stakeholder.name,
      stakeholder.influence,
      ...(stakeholder.relationship === 'unknown' ? [] : [stakeholder.relationship]),
      ...(stakeholder.role === 'unknown' ? [] : [role]),
      ...(stakeholder.title === undefined ? [] : [stakeholder.title]),
      ...(stakeholder.organization === undefined ? [] : [stakeholder.organization])
    ];
    if (stakeholder.claims.length === 0 || !tupleSupported(identity, stakeholder.claims)) return [];
    return [
      {
        ...stakeholder,
        goals: stakeholder.goals.filter((goal) => assertionSupported(goal, stakeholder.claims)),
        concerns: stakeholder.concerns.filter((concern) =>
          assertionSupported(concern, stakeholder.claims)
        )
      }
    ];
  });
  const supportedNames = new Set(supportedStakeholders.map((stakeholder) => stakeholder.name));
  const unsupportedStakeholders = stakeholders.filter(
    (stakeholder) => !supportedNames.has(stakeholder.name)
  );
  const insufficient = [
    ...top.insufficient,
    ...stakeholders.flatMap((stakeholder) => stakeholder.insufficient)
  ];
  const warnings = supportWarnings(insufficient);
  const validClaimIds = new Set(
    [...top.kept, ...supportedStakeholders.flatMap((stakeholder) => stakeholder.claims)].map(
      (claim) => claim.id
    )
  );
  return stakeholderArtifactSchema.parse({
    ...parsed,
    claims: top.kept,
    stakeholders: supportedStakeholders.map(withoutInsufficient),
    coverageGaps: [
      ...parsed.coverageGaps.filter(safeInformationRequest),
      ...insufficient.map(({ assessment }) => `Verify evidence for claim ${assessment.claimId}.`),
      ...(unsupportedStakeholders.length === 0 ? [] : ['Verify unsupported stakeholder records.'])
    ],
    reviewWarnings: mergeReviewWarnings(parsed.reviewWarnings, warnings, validClaimIds)
  });
}

/** Removes unsupported commercial content without discarding valid model review warnings. */
export function validateCommercialArtifact(
  value: unknown,
  manifestId: string,
  evidence: readonly AgentEvidenceRecord[]
): CommercialArtifact {
  const parsed = commercialArtifactSchema.parse(value);
  if (parsed.evidenceManifestId !== manifestId)
    throw new DomainValidationError('Commercial artifact evidence manifest does not match');
  assertUniqueClaims([parsed.claims, ...parsed.commercialTerms.map((term) => term.claims)]);
  const map = evidenceMap(evidence);
  const top = pruneClaims(parsed.claims, map);
  const terms = parsed.commercialTerms.map((term) => {
    const claims = pruneClaims(term.claims, map);
    return { ...term, claims: claims.kept, insufficient: claims.insufficient };
  });
  const supportedTerms = terms.filter(
    (term) =>
      term.claims.length > 0 &&
      tupleSupported(
        [term.term, term.detail, ...(term.status === 'unknown' ? [] : [term.status])],
        term.claims
      )
  );
  const insufficient = [...top.insufficient, ...terms.flatMap((term) => term.insufficient)];
  const allSupportedClaims = [...top.kept, ...supportedTerms.flatMap((term) => term.claims)];
  const warnings = supportWarnings(insufficient);
  const validClaimIds = new Set(allSupportedClaims.map((claim) => claim.id));
  return commercialArtifactSchema.parse({
    ...parsed,
    claims: top.kept,
    commercialTerms: supportedTerms.map(withoutInsufficient),
    policyTriggers: parsed.policyTriggers.filter((trigger) =>
      assertionSupported(trigger, allSupportedClaims)
    ),
    reviewWarnings: mergeReviewWarnings(parsed.reviewWarnings, warnings, validClaimIds)
  });
}

/** Collects every claim group that must have unique identifiers and authorized support. */
function briefClaimGroups(brief: DealBrief): readonly (readonly Claim[])[] {
  return [
    brief.dealSnapshot.claims ?? [],
    brief.executiveSummary.claims ?? [],
    brief.buyerGoalsAndBusinessDrivers.claims ?? [],
    brief.stakeholderMap.claims ?? [],
    ...brief.stakeholderMap.stakeholders.map((stakeholder) => stakeholder.claims),
    brief.negotiationState.claims ?? [],
    ...brief.recommendedNextActions.actions.map((action) => action.claims),
    ...brief.sourceEvidence.evidence.map((summary) => summary.claims)
  ];
}

/** Produces a support-checked brief while retaining valid generated review signals. */
export function validateDealBrief(
  value: unknown,
  evidence: readonly AgentEvidenceRecord[],
  context: Pick<AgentContext, 'account' | 'opportunity'>
): DealBrief {
  const parsed = dealBriefSchema.parse(value);
  assertUniqueClaims(briefClaimGroups(parsed));
  const map = evidenceMap(evidence);
  const insufficient: RejectedClaim[] = [];
  const process = (claims: readonly Claim[] | undefined): readonly Claim[] | undefined => {
    if (claims === undefined) return undefined;
    const result = pruneClaims(claims, map);
    insufficient.push(...result.insufficient);
    return result.kept;
  };
  const actions = parsed.recommendedNextActions.actions.flatMap((action) => {
    const result = pruneClaims(action.claims, map);
    insufficient.push(...result.insufficient);
    if (
      result.insufficient.length > 0 ||
      result.kept.length === 0 ||
      !safeRecommendationAction(action.action) ||
      !assertionSupported(action.rationale, result.kept)
    )
      return [];
    return [
      {
        action: action.action,
        priority: action.priority,
        rationale: action.rationale,
        claims: result.kept,
        ...(action.owner === undefined ||
        (!safeGenericOwner(action.owner) && !fieldSupported(action.owner, result.kept))
          ? {}
          : { owner: action.owner }),
        ...(action.dueDate === undefined || !fieldSupported(action.dueDate, result.kept)
          ? {}
          : { dueDate: action.dueDate })
      }
    ];
  });
  const snapshotClaims = process(parsed.dealSnapshot.claims) ?? [];
  const summaryClaims = process(parsed.executiveSummary.claims) ?? [];
  const buyerClaims = process(parsed.buyerGoalsAndBusinessDrivers.claims) ?? [];
  const stakeholderSectionClaims = process(parsed.stakeholderMap.claims) ?? [];
  const negotiationClaims = process(parsed.negotiationState.claims) ?? [];
  const supportedStakeholders = parsed.stakeholderMap.stakeholders.flatMap((stakeholder) => {
    const claims = process(stakeholder.claims) ?? [];
    const role = stakeholder.role.replaceAll('_', ' ');
    const identity = [
      stakeholder.name,
      stakeholder.influence,
      ...(stakeholder.relationship === 'unknown' ? [] : [stakeholder.relationship]),
      ...(stakeholder.role === 'unknown' ? [] : [role]),
      ...(stakeholder.title === undefined ? [] : [stakeholder.title]),
      ...(stakeholder.organization === undefined ? [] : [stakeholder.organization])
    ];
    if (claims.length === 0 || !tupleSupported(identity, claims)) return [];
    return [
      {
        ...stakeholder,
        goals: stakeholder.goals.filter((goal) => assertionSupported(goal, claims)),
        concerns: stakeholder.concerns.filter((concern) => assertionSupported(concern, claims)),
        claims
      }
    ];
  });
  const supportedEvidenceSummaries = parsed.sourceEvidence.evidence.flatMap((summary) => {
    const source = map.get(summary.evidenceId);
    if (source === undefined) return [];
    const claims = process(summary.claims) ?? [];
    const expectedSourceType =
      source.sourceType === 'salesforce'
        ? 'crm'
        : source.sourceType === 'gong_summary' || source.sourceType === 'gong_transcript'
          ? 'conversation'
          : source.sourceType;
    if (
      claims.length === 0 ||
      !assertionSupported(summary.summary, claims) ||
      summary.sourceType !== expectedSourceType ||
      source.eventDate === undefined ||
      !summary.capturedAt.startsWith(source.eventDate)
    )
      return [];
    return [{ ...summary, claims }];
  });
  const summaryWasReplaced =
    !isExplicitUncertainty(parsed.executiveSummary.narrative) &&
    !assertionSupported(parsed.executiveSummary.narrative, summaryClaims);
  const negotiationWasReplaced =
    !isExplicitUncertainty(parsed.negotiationState.currentState) &&
    !assertionSupported(parsed.negotiationState.currentState, negotiationClaims);
  const nakedAssertions = [
    ...parsed.buyerGoalsAndBusinessDrivers.goals.filter(
      (value) => !assertionSupported(value, buyerClaims)
    ),
    ...parsed.buyerGoalsAndBusinessDrivers.businessDrivers.filter(
      (value) => !assertionSupported(value, buyerClaims)
    ),
    ...parsed.negotiationState.risks.filter(
      (value) => !assertionSupported(value, negotiationClaims)
    ),
    ...(summaryWasReplaced ? [parsed.executiveSummary.narrative] : []),
    ...(negotiationWasReplaced ? [parsed.negotiationState.currentState] : []),
    ...parsed.stakeholderMap.stakeholders
      .filter((stakeholder) => stakeholder.claims.length === 0)
      .map((stakeholder) => `stakeholder ${stakeholder.name} (${stakeholder.role})`),
    ...parsed.recommendedNextActions.actions
      .filter((action) => action.claims.length === 0)
      .map((action) => action.action),
    ...(snapshotClaims.length === 0
      ? [
          ...(parsed.dealSnapshot.amount === undefined
            ? []
            : [`amount ${parsed.dealSnapshot.amount}`]),
          ...(parsed.dealSnapshot.currency === undefined
            ? []
            : [`currency ${parsed.dealSnapshot.currency}`]),
          ...(parsed.dealSnapshot.closeDate === undefined
            ? []
            : [`close date ${parsed.dealSnapshot.closeDate}`]),
          ...(parsed.dealSnapshot.owner === undefined ? [] : [`owner ${parsed.dealSnapshot.owner}`])
        ]
      : [])
  ];
  const warnings = supportWarnings(insufficient);
  const validClaimIds = new Set(
    [
      ...snapshotClaims,
      ...summaryClaims,
      ...buyerClaims,
      ...stakeholderSectionClaims,
      ...negotiationClaims,
      ...supportedStakeholders.flatMap((stakeholder) => stakeholder.claims),
      ...actions.flatMap((action) => action.claims),
      ...supportedEvidenceSummaries.flatMap((summary) => summary.claims)
    ].map((claim) => claim.id)
  );
  return dealBriefSchema.parse({
    ...parsed,
    dealSnapshot: {
      accountName: context.account.name,
      opportunityName: context.opportunity.name,
      stage: context.opportunity.stage,
      ...(snapshotClaims.length === 0
        ? {}
        : {
            claims: snapshotClaims,
            ...(parsed.dealSnapshot.closeDate === undefined ||
            !tupleSupported(['close date', parsed.dealSnapshot.closeDate], snapshotClaims)
              ? {}
              : { closeDate: parsed.dealSnapshot.closeDate }),
            ...(parsed.dealSnapshot.amount === undefined ||
            !tupleSupported(['amount', parsed.dealSnapshot.amount], snapshotClaims)
              ? {}
              : { amount: parsed.dealSnapshot.amount }),
            ...(parsed.dealSnapshot.currency === undefined ||
            !tupleSupported(['currency', parsed.dealSnapshot.currency], snapshotClaims)
              ? {}
              : { currency: parsed.dealSnapshot.currency }),
            ...(parsed.dealSnapshot.owner === undefined ||
            !tupleSupported(['owner', parsed.dealSnapshot.owner], snapshotClaims)
              ? {}
              : { owner: parsed.dealSnapshot.owner })
          })
    },
    executiveSummary: {
      narrative: !summaryWasReplaced
        ? parsed.executiveSummary.narrative
        : 'Insufficient supported evidence is available for an executive summary.',
      ...(summaryClaims.length === 0 ? {} : { claims: summaryClaims })
    },
    buyerGoalsAndBusinessDrivers: {
      goals: parsed.buyerGoalsAndBusinessDrivers.goals.filter((value) =>
        assertionSupported(value, buyerClaims)
      ),
      businessDrivers: parsed.buyerGoalsAndBusinessDrivers.businessDrivers.filter((value) =>
        assertionSupported(value, buyerClaims)
      ),
      ...(buyerClaims.length === 0 ? {} : { claims: buyerClaims })
    },
    stakeholderMap: {
      stakeholders: supportedStakeholders,
      ...((parsed.stakeholderMap.coverageGaps?.filter(safeInformationRequest).length ?? 0) === 0 &&
      supportedStakeholders.length === parsed.stakeholderMap.stakeholders.length
        ? {}
        : {
            coverageGaps: [
              ...(parsed.stakeholderMap.coverageGaps?.filter(safeInformationRequest) ?? []),
              ...(supportedStakeholders.length === parsed.stakeholderMap.stakeholders.length
                ? []
                : ['Verify unsupported stakeholder records.'])
            ]
          }),
      ...(stakeholderSectionClaims.length === 0 ? {} : { claims: stakeholderSectionClaims })
    },
    negotiationState: {
      currentState: !negotiationWasReplaced
        ? parsed.negotiationState.currentState
        : 'Insufficient supported evidence is available for a negotiation-state assessment.',
      risks: parsed.negotiationState.risks.filter((value) =>
        assertionSupported(value, negotiationClaims)
      ),
      ...(parsed.negotiationState.leverage === undefined
        ? {}
        : {
            leverage: parsed.negotiationState.leverage.filter((value) =>
              assertionSupported(value, negotiationClaims)
            )
          }),
      ...(negotiationClaims.length === 0 ? {} : { claims: negotiationClaims })
    },
    recommendedNextActions: { actions },
    missingInformation: {
      items: [
        ...parsed.missingInformation.items
          .filter((item) => safeInformationRequest(item.question))
          .map((item) => ({
            question: item.question,
            whyItMatters: 'Additional information is required before the deal team can act.',
            ...(item.owner === undefined || !safeGenericOwner(item.owner)
              ? {}
              : { owner: item.owner })
          })),
        ...insufficient.map(({ assessment }) => ({
          question: `Verify evidence for claim ${assessment.claimId}.`,
          whyItMatters: assessment.reason
        })),
        ...(nakedAssertions.length === 0
          ? []
          : [
              {
                question: 'Verify unsupported generated assertions before use.',
                whyItMatters:
                  'The generated assertion lacks support in the authorized evidence manifest.'
              }
            ])
      ]
    },
    sourceEvidence: {
      evidence: supportedEvidenceSummaries
    },
    confidenceAndReviewWarnings: {
      ...parsed.confidenceAndReviewWarnings,
      warnings: mergeReviewWarnings(
        parsed.confidenceAndReviewWarnings.warnings,
        warnings,
        validClaimIds
      )
    }
  });
}

/** Fails closed before prompting if evidence escaped its immutable deal binding. */
export function assertAgentContextBindings(context: AgentContext): void {
  runIdSchema.parse(context.runId);
  accountIdSchema.parse(context.account.id);
  opportunityIdSchema.parse(context.opportunity.id);
  if (
    context.account.name.length === 0 ||
    context.account.name.length > 2_000 ||
    context.opportunity.name.length === 0 ||
    context.opportunity.name.length > 2_000 ||
    context.opportunity.stage.length === 0 ||
    context.opportunity.stage.length > 2_000
  ) {
    throw new DomainValidationError('Trusted deal context is empty or exceeds its prompt bound');
  }
  if (context.generation.durableAttempt.runScope !== context.runId)
    throw new DomainValidationError('Durable model-attempt scope does not match the agent run');
  if (context.manifest.runId !== context.runId)
    throw new DomainValidationError('Evidence manifest run binding does not match');
  const expectedBinding = createEvidenceScopeBinding(
    { accountId: context.account.id, opportunityId: context.opportunity.id },
    context.currentScope
  );
  const expectedScopeHash = hashEvidenceScopeBinding(expectedBinding);
  if (
    context.manifest.binding.target.accountId !== context.account.id ||
    context.manifest.binding.target.opportunityId !== context.opportunity.id ||
    hashEvidenceScopeBinding(context.manifest.binding) !== expectedScopeHash ||
    context.manifest.scopeHash !== expectedScopeHash
  ) {
    throw new DomainValidationError(
      'Evidence manifest target or current authorization scope does not match'
    );
  }
  const evidenceIds = new Set<string>();
  const citationIds = new Set<string>();
  const manifestEntries = new Map(
    context.manifestEntries.map((entry) => [entry.evidenceId, entry])
  );
  if (
    manifestEntries.size !== context.manifestEntries.length ||
    manifestEntries.size !== context.evidence.length
  ) {
    throw new DomainValidationError('Duplicate evidence manifest entry or incomplete entry set');
  }
  for (const record of context.evidence) {
    if (evidenceIds.has(record.evidenceId) || citationIds.has(record.citationId)) {
      throw new DomainValidationError('Duplicate evidence or citation identifier in agent context');
    }
    evidenceIds.add(record.evidenceId);
    citationIds.add(record.citationId);
    const entry = manifestEntries.get(record.evidenceId);
    if (
      entry === undefined ||
      entry.manifestId !== context.manifest.id ||
      entry.accountId !== context.account.id ||
      entry.opportunityId !== context.opportunity.id ||
      entry.scopeHash !== context.manifest.scopeHash ||
      entry.citationId !== record.citationId ||
      entry.contentHash !== record.contentHash ||
      entry.sourceLocator !== record.sourceLocator ||
      entry.sourceType !== record.sourceType ||
      entry.sensitivity !== record.sensitivity ||
      entry.policyHash !== record.policyHash ||
      entry.eventDate !== record.eventDate
    ) {
      throw new DomainValidationError(
        'Evidence record does not match its immutable manifest entry'
      );
    }
    const actualExcerptHash = createHash('sha256').update(record.content).digest('hex');
    if (
      entry.includedCharacters !== record.content.length ||
      entry.excerptHash !== actualExcerptHash
    ) {
      throw new DomainValidationError(
        'Evidence content does not match its immutable manifest excerpt'
      );
    }
    if (record.accountId !== context.account.id)
      throw new DomainValidationError('Evidence account binding does not match');
    if (record.opportunityId !== context.opportunity.id)
      throw new DomainValidationError('Evidence opportunity binding does not match');
    if (record.policyHash !== context.manifest.policyHash)
      throw new DomainValidationError('Evidence policy binding does not match');
  }
}

/** Collects the authorized evidence identifiers cited anywhere in a generated artifact. */
export function collectArtifactCitationEvidenceIds(value: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current !== 'object' || current === null) return;
    const record = current as Record<string, unknown>;
    if (
      typeof record.evidenceId === 'string' &&
      typeof record.id === 'string' &&
      record.id.startsWith('citation_')
    )
      ids.add(record.evidenceId);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return ids;
}
