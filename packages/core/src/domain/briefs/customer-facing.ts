import type { DealBrief } from './schema.js';

/**
 * Customer-facing audience and seller commitment language are approval signals in their own right,
 * independent of evidence grounding and of whether anything commercial is being conceded.
 */
export type CustomerFacingSignal = Readonly<{
  /** At least one recommended action explicitly targets the customer audience. */
  customerAudienceAction: boolean;
  /** Narrative prose speaks for the company and commits it. */
  outwardCommitmentLanguage: boolean;
  /** Either signal; the deterministic policy's customer-facing trigger. */
  customerFacingLanguage: boolean;
}>;

/**
 * The seller speaking in the first person and committing: "we will waive", "we can offer".
 *
 * Recommended-action text is deliberately absent from this check. Its required typed audience is
 * authoritative, so arbitrary wording cannot bypass or accidentally activate approval policy.
 */
const OUTWARD_COMMITMENT =
  /\bwe(?:'ll|'re| will| can| could| would| shall| are prepared to| are able to| have agreed to| agree to| commit to| intend to| plan to)\b[^.!?]*\b(?:offer|grant|provide|waive|extend|guarantee|promise|commit|honou?r|deliver|give|accept|cover|match|include|reduce|discount|credit|refund|disclose|reveal|share|send|bypass|concede)\w*/i;

/** Classifies explicit action audience and narrative commitment shape independently of grounding. */
export function classifyCustomerFacingLanguage(brief: DealBrief): CustomerFacingSignal {
  const customerAudienceAction = brief.recommendedNextActions.actions.some(
    ({ audience }) => audience === 'customer'
  );
  const outwardCommitmentLanguage = [
    brief.executiveSummary.narrative,
    brief.negotiationState.currentState
  ].some((value) => OUTWARD_COMMITMENT.test(value));
  return Object.freeze({
    customerAudienceAction,
    outwardCommitmentLanguage,
    customerFacingLanguage: customerAudienceAction || outwardCommitmentLanguage
  });
}

/**
 * Approval edits may add customer-facing work but cannot downgrade an existing customer-facing
 * requirement merely by relabeling or removing that work in the replacement payload.
 */
export function requiresCustomerFacingApprovalAfterEdit(
  original: DealBrief,
  edited: DealBrief
): boolean {
  return (
    classifyCustomerFacingLanguage(original).customerFacingLanguage ||
    classifyCustomerFacingLanguage(edited).customerFacingLanguage
  );
}
