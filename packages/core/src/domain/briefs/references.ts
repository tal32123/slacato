import type { Citation, Claim, DealBrief } from './schema.js';
import { DomainValidationError } from '../shared/errors.js';
import type { EvidenceId } from '../shared/ids.js';

/** Immutable evidence references retained across every claim-bearing DealBrief section. */
export type DealBriefReferences = Readonly<{
  citations: readonly Citation[];
  evidenceIds: readonly EvidenceId[];
}>;

/** Compares bounded identifiers with locale-independent code-unit ordering. */
function compareIdentifiers(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Determines whether two occurrences preserve the immutable evidence and locator binding. */
function citationsHaveSameBinding(left: Citation, right: Citation): boolean {
  return left.id === right.id
    && left.evidenceId === right.evidenceId
    && left.locator === right.locator;
}

/**
 * Collects deterministic citation and evidence references through all nine DealBrief sections.
 * Repeated identical citations are retained once; conflicting uses of a citation ID are invalid.
 */
export function collectDealBriefReferences(brief: DealBrief): DealBriefReferences {
  const citationsById = new Map<Citation['id'], Citation>();
  const evidenceIds = new Set<EvidenceId>();

  /** Adds every citation and cited evidence ID from one explicitly selected claim location. */
  const collectClaims = (claims: readonly Claim[] | undefined): void => {
    if (claims === undefined) return;
    for (const claim of claims) {
      for (const citation of claim.citations) {
        if (existing !== undefined && !citationsHaveSameBinding(existing, citation)) {
        if (existing !== undefined && !citationsAreIdentical(existing, citation)) {
          throw new DomainValidationError('A citation ID is bound to conflicting evidence', {
            citationId: citation.id
          });
        }
        citationsById.set(citation.id, citation);
        evidenceIds.add(citation.evidenceId);
      }
    }
  };

  collectClaims(brief.dealSnapshot.claims);
  collectClaims(brief.executiveSummary.claims);
  collectClaims(brief.buyerGoalsAndBusinessDrivers.claims);

  collectClaims(brief.stakeholderMap.claims);
  for (const stakeholder of brief.stakeholderMap.stakeholders) collectClaims(stakeholder.claims);

  collectClaims(brief.negotiationState.claims);

  for (const action of brief.recommendedNextActions.actions) collectClaims(action.claims);

  // missingInformation contains questions rather than claims.

  for (const evidence of brief.sourceEvidence.evidence) {
    evidenceIds.add(evidence.evidenceId);
    collectClaims(evidence.claims);
  }

  // confidenceAndReviewWarnings references claim IDs but does not contain claims.

  const citations = Object.freeze(
    [...citationsById.values()].sort((left, right) => compareIdentifiers(left.id, right.id))
  );
  const sortedEvidenceIds = Object.freeze([...evidenceIds].sort(compareIdentifiers));
  return Object.freeze({ citations, evidenceIds: sortedEvidenceIds });
}
