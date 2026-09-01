import { DomainValidationError } from '../shared/errors.js';
import type { EvidenceId } from '../shared/ids.js';
import type { Citation, Claim, DealBrief } from './schema.js';

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
  return (
    left.id === right.id && left.evidenceId === right.evidenceId && left.locator === right.locator
  );
}

/**
 * Collects deterministic DealBrief citation and evidence references while rejecting conflicting uses of a citation ID.
 */
export function collectDealBriefReferences(brief: DealBrief): DealBriefReferences {
  const citationsById = new Map<Citation['id'], Citation>();
  const evidenceIds = new Set<EvidenceId>();

  /** Adds every citation and cited evidence ID from one explicitly selected claim location. */
  const collectClaims = (claims: readonly Claim[] | undefined): void => {
    if (claims === undefined) return;
    for (const claim of claims) {
      for (const citation of claim.citations) {
        const existing = citationsById.get(citation.id);
        if (existing !== undefined && !citationsHaveSameBinding(existing, citation)) {
          throw new DomainValidationError('A citation ID is bound to conflicting evidence', {
            citationId: citation.id
          });
        }
        if (existing === undefined) citationsById.set(citation.id, citation);
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

/** The stable, source-specific identity a citation points at. */
export type EvidenceIdentity = Readonly<{ sourcePath: string; key: string; id: string }>;

/**
 * Dataset root the assignment's citation format names, as in
 * `source=synthetic_data/gong/gong_call_summaries.tsv, call_id=CALL-008`.
 *
 * Locators are stored relative to this root, so it is applied here - at the single point every
 * citation surface resolves through - rather than baked into ingested locators, where changing a
 * display convention would force a re-ingest and a re-embed.
 */
const DATASET_ROOT = 'synthetic_data/';

/** Roots a stored locator path in the cited dataset without double-prefixing an already-rooted path. */
function datasetPath(sourcePath: string): string {
  return sourcePath.startsWith(DATASET_ROOT) ? sourcePath : `${DATASET_ROOT}${sourcePath}`;
}

/** Returns the record identifier encoded in an evidence locator. */
function locatorRecordId(locator: string): string | undefined {
  return locator.split('#')[1]?.split('/')[0];
}

/** Builds an identity only when the source supplies a non-empty identifier. */
function identity(
  sourcePath: string,
  key: string,
  id: string | undefined
): EvidenceIdentity | undefined {
  return id === undefined || id.trim().length === 0
    ? undefined
    : { sourcePath: datasetPath(sourcePath), key, id: id.trim() };
}

/**
 * Resolves the source file and stable source ID a citation refers to.
 *
 * Callers that have already parsed the evidence body may supply its fields; the locator alone is
 * otherwise sufficient, so exported artifacts and the API surface derive the same identity.
 */
export function resolveEvidenceIdentity(
  locator: string,
  fields: Readonly<Record<string, string>> = {}
): EvidenceIdentity | undefined {
  const trimmed = locator.trim();
  const sourcePath = trimmed.split('#', 1)[0];
  if (!sourcePath) return undefined;
  const recordId = locatorRecordId(trimmed);
  if (sourcePath.endsWith('/opportunities.tsv'))
    return identity(sourcePath, 'opportunity_id', fields.opportunityId ?? recordId);
  if (sourcePath.endsWith('/accounts.tsv'))
    return identity(sourcePath, 'account_id', fields.accountId ?? recordId);
  if (sourcePath.endsWith('/contacts.tsv'))
    return identity(sourcePath, 'contact_id', fields.contactId ?? recordId);
  if (sourcePath.includes('/gong_call_summaries.tsv') || sourcePath.includes('/transcripts/'))
    return identity(
      sourcePath,
      'call_id',
      fields.callId ?? sourcePath.match(/(CALL-\d+)/)?.[1] ?? recordId
    );
  if (sourcePath.endsWith('/pricing_notes.tsv'))
    return identity(sourcePath, 'pricing_note_id', fields.pricingNoteId ?? recordId);
  if (sourcePath.endsWith('/account_team_updates.tsv'))
    return identity(sourcePath, 'update_id', fields.updateId ?? recordId);
  if (sourcePath.endsWith('/deal_desk_policy.md'))
    return { sourcePath: datasetPath(sourcePath), key: 'policy_id', id: 'deal-desk-policy' };
  return identity(sourcePath, 'record_id', recordId);
}

/**
 * Renders the one citation format the assignment asks for, naming the source file and stable ID.
 *
 * Every surface that shows a citation uses this, so an exported brief and the reviewer workspace
 * cite the same evidence the same way.
 */
export function formatEvidenceCitation(
  locator: string,
  fields: Readonly<Record<string, string>> = {}
): string | undefined {
  const resolved = resolveEvidenceIdentity(locator, fields);
  return resolved === undefined
    ? undefined
    : `source=${resolved.sourcePath}, ${resolved.key}=${resolved.id}`;
}
