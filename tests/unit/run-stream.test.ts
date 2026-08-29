import type { RunDetailResponse } from '@slacato/contracts';
import { describe, expect, it } from 'vitest';
import { applyRunEvent, openRunEventStream, type RunStreamSource } from '../../apps/web/src/features/runs/stream';

const timestamp = '2026-08-29T12:00:00.000Z';
const detail: RunDetailResponse = {
  sessionVersion: 'session-1', runId: 'run-1', opportunityId: 'OPP-1001', opportunityName: 'Atlas Renewal',
  accountName: 'Atlas', initiatedBy: 'Maya Chen', status: 'validating', version: 5,
  watermark: 'event-5', watermarkSequence: 5, terminal: false, createdAt: timestamp, updatedAt: timestamp,
  progress: {
    phase: 'validating', retrievalCount: 17, validationRetries: 1,
    specialists: [
      { name: 'conversation', status: 'completed' },
      { name: 'stakeholder', status: 'completed' },
      { name: 'commercial', status: 'completed' }
    ],
    completedSections: ['Executive Summary'],
    timeline: [{ sequence: 5, eventId: 'event-5', phase: 'validating', label: 'Validating the brief', at: timestamp }]
  }
};

function envelope(sequence: number, streamId = 'run-1') {
  return {
    id: `event-${sequence}`, streamId, sequence, version: 1, type: 'awaiting_approval', timestamp,
    payload: { version: 6, subjectHash: 'a'.repeat(64), quorumVersion: 'deal-brief-approval-v1' }
  };
}

describe('validated run stream state', () => {
  it('accepts only a matching, current-generation, monotonic envelope', () => {
    expect(applyRunEvent(detail, envelope(5), 3, 3)).toBe(detail);
    expect(applyRunEvent(detail, envelope(6, 'run-other'), 3, 3)).toBe(detail);
    expect(applyRunEvent(detail, envelope(6), 2, 3)).toBe(detail);
    expect(applyRunEvent(detail, { ...envelope(6), prompt: 'raw' }, 3, 3)).toBe(detail);

    const next = applyRunEvent(detail, envelope(6), 3, 3);
    expect(next).not.toBe(detail);
    expect(next).toMatchObject({ status: 'awaiting_approval', version: 6, watermark: 'event-6', watermarkSequence: 6 });
    expect(next.progress.timeline.at(-1)).toMatchObject({ sequence: 6, phase: 'awaiting_approval' });
  });

  it('opens only non-terminal streams at the persisted watermark and closes ownership exactly once', () => {
    const sources: FakeSource[] = [];
    const registered: RunStreamSource[] = [];
    const dispose = openRunEventStream({
      detail,
      generation: 4,
      currentGeneration: () => 4,
      createSource: (url) => {
        const source = new FakeSource(url);
        sources.push(source);
        return source;
      },
      registerStream: (source) => {
        registered.push(source);
        return () => undefined;
      },
      onEvent: () => undefined,
      onConnection: () => undefined,
      onResync: () => undefined
    });
    expect(sources[0]?.url).toBe('/api/runs/run-1/events?after=event-5');
    expect(registered).toEqual([sources[0]]);
    dispose();
    dispose();
    expect(sources[0]?.closeCalls).toBe(1);

    openRunEventStream({
      detail: { ...detail, terminal: true }, generation: 4, currentGeneration: () => 4,
      createSource: () => { throw new Error('terminal runs must not subscribe'); },
      registerStream: () => { throw new Error('terminal runs must not register'); },
      onEvent: () => undefined, onConnection: () => undefined, onResync: () => undefined
    });
  });
});

class FakeSource implements RunStreamSource {
  public readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  public closeCalls = 0;
  public constructor(public readonly url: string) {}
  public addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  public close(): void { this.closeCalls += 1; }
}
