import { describe, expect, it } from 'vitest';
import { InvalidRunTransitionError, transitionRun } from '@slacato/core';

describe('run state machine', () => {
  it('finalizes an approved snapshot without returning to synthesis', () => {
    expect(transitionRun('awaiting_approval', 'approval_granted')).toBe('finalizing');
  });

  it('rejects an event that is not valid for the current run state', () => {
    expect(() => transitionRun('created', 'complete')).toThrow(InvalidRunTransitionError);
  });

  it('allows finalizing to complete but not generate again', () => {
    expect(transitionRun('finalizing', 'complete')).toBe('completed');
    expect(() => transitionRun('finalizing', 'synthesis_completed')).toThrow(InvalidRunTransitionError);
  });
});
