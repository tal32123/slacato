import type { RunFailureReason } from '@slacato/contracts';

/**
 * Puts a run's failure code into the words the interface uses everywhere else.
 *
 * The workflow classifies every fatal stop with one of these codes, but until now the code
 * travelled only on the `fail` event: a reader who arrived after the run stopped -- a reload, a
 * resumed page, the guided tour narrating someone else's run -- saw "Run failed safely" and no
 * account of what failed. Each sentence names the step that stopped and stays inside what the
 * code actually asserts; none of them guesses at a cause the run did not record.
 */
const REASONS: Readonly<Record<RunFailureReason, string>> = {
  conversation_unavailable: 'the conversation specialist could not complete its analysis',
  stakeholder_unavailable: 'the stakeholder specialist could not complete its analysis',
  commercial_unavailable: 'the commercial specialist could not complete its analysis',
  strategy_unavailable: 'strategy synthesis could not complete',
  commercial_specialist_failed:
    'the commercial specialist failed, and its analysis is required rather than optional',
  strategy_generation_failed: 'the model did not return a usable strategy for this deal',
  draft_validation_failed: 'the synthesized draft did not pass validation, and its retries ran out',
  workflow_failed: 'the workflow stopped before it could finish'
};

/** Describes why a run failed, or returns undefined when the run recorded no reason. */
export function describeRunFailure(
  reason: RunFailureReason | null | undefined
): string | undefined {
  return reason === null || reason === undefined ? undefined : REASONS[reason];
}
