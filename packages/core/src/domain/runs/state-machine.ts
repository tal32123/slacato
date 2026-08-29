import { InvalidRunTransitionError } from '../shared/errors.js';
import type { RunEvent, RunStatus } from './contracts.js';

type TransitionRow = Readonly<Partial<Record<RunEvent, RunStatus>>>;

/**
 * Exhaustive workflow transition table. `finalizing` deliberately permits only
 * deterministic completion or failure; no agent-generation event can restart synthesis.
 */
const transitions: Readonly<Record<RunStatus, TransitionRow>> = {
  created: { start: 'retrieving', fail: 'failed', cancel: 'cancelled' },
  retrieving: { retrieval_completed: 'specialists_running', fail: 'failed', cancel: 'cancelled' },
  specialists_running: {
    specialists_completed: 'synthesizing',
    fail: 'failed',
    cancel: 'cancelled'
  },
  synthesizing: { synthesis_completed: 'validating', fail: 'failed', cancel: 'cancelled' },
  validating: {
    validation_requires_approval: 'awaiting_approval',
    validation_completed: 'finalizing',
    fail: 'failed',
    cancel: 'cancelled'
  },
  awaiting_approval: {
    approval_granted: 'finalizing',
    approval_rejected: 'rejected',
    fail: 'failed',
    cancel: 'cancelled'
  },
  finalizing: { complete: 'completed', fail: 'failed', cancel: 'cancelled' },
  completed: {},
  rejected: {},
  failed: {},
  cancelled: {}
};

/** Applies one valid workflow event or rejects an impossible persisted state transition. */
export function transitionRun(status: RunStatus, event: RunEvent): RunStatus {
  const next = transitions[status][event];
  if (next === undefined) throw new InvalidRunTransitionError(status, event);
  return next;
}
