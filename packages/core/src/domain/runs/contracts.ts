import { z } from 'zod';

/** Persisted lifecycle states for a DealBrief workflow run. */
export const runStatusSchema = z.enum([
  'created',
  'retrieving',
  'specialists_running',
  'synthesizing',
  'validating',
  'awaiting_approval',
  'finalizing',
  'completed',
  'rejected',
  'failed',
  'cancelled'
]);

/** Events recognized by the exhaustive workflow state machine. */
export const runEventSchema = z.enum([
  'start',
  'retrieval_completed',
  'specialists_completed',
  'synthesis_completed',
  'validation_requires_approval',
  'validation_completed',
  'approval_granted',
  'approval_rejected',
  'complete',
  'fail',
  'cancel'
]);

/** Union of persisted lifecycle states accepted by the run state machine. */
export type RunStatus = z.infer<typeof runStatusSchema>;
/** Union of workflow events accepted by the run state machine. */
export type RunEvent = z.infer<typeof runEventSchema>;
