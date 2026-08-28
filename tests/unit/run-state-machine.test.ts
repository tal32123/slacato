import { describe, expect, it } from 'vitest';
import { InvalidRunTransitionError, transitionRun } from '@slacato/core';

describe('run state machine', () => {
  it('finalizes an approved snapshot without returning to synthesis', () => {
    expect(transitionRun('awaiting_approval', 'approval_granted')).toBe('finalizing');
  });

  it('routes validation outcomes through the explicit approval decision point', () => {
    expect(transitionRun('validating', 'validation_requires_approval')).toBe('awaiting_approval');
    expect(transitionRun('validating', 'validation_completed')).toBe('finalizing');
    expect(() => transitionRun('validating', 'approval_granted')).toThrow(InvalidRunTransitionError);
    expect(() => transitionRun('validating', 'approval_rejected')).toThrow(InvalidRunTransitionError);
  });

  it('accepts approval rejection only after the approval checkpoint', () => {
    expect(transitionRun('awaiting_approval', 'approval_rejected')).toBe('rejected');
  });

  it('rejects an event that is not valid for the current run state', () => {
    expect(() => transitionRun('created', 'complete')).toThrow(InvalidRunTransitionError);
  });

  it('allows finalizing to complete but not generate again', () => {
    expect(transitionRun('finalizing', 'complete')).toBe('completed');
    expect(transitionRun('finalizing', 'fail')).toBe('failed');
    expect(() => transitionRun('finalizing', 'synthesis_completed')).toThrow(InvalidRunTransitionError);
  });
});
