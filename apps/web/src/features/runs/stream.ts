import {
  type RunDetailResponse,
  type RunEventEnvelope,
  type RunStatus,
  runDetailResponseSchema,
  runEventEnvelopeSchema,
  runEventFallbackStatuses,
  runEventResyncInstructionSchema,
  runEventTypes,
  runStatusSchema,
  terminalRunEventTypes
} from '@slacato/contracts';

export interface RunStreamSource {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

type ConnectionState = 'connected' | 'reconnecting';

/** Applies a valid new run event to the detail shown in the interface. */
export function applyRunEvent(
  current: RunDetailResponse,
  candidate: unknown,
  connectionGeneration: number,
  currentGeneration: number
): RunDetailResponse {
  if (connectionGeneration !== currentGeneration) return current;
  const parsed = runEventEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return current;
  const event = parsed.data as RunEventEnvelope;
  if (event.streamId !== current.runId || event.sequence <= current.watermarkSequence)
    return current;
  const status = statusForEvent(event, current.status);
  const version =
    'version' in event.payload && typeof event.payload.version === 'number'
      ? event.payload.version
      : current.version;
  return runDetailResponseSchema.parse({
    ...current,
    status,
    version,
    watermark: event.id,
    watermarkSequence: event.sequence,
    terminal:
      terminalRunEventTypes.includes(event.type) ||
      ('terminal' in event.payload && event.payload.terminal === true),
    updatedAt: event.timestamp,
    progress: {
      ...current.progress,
      phase: status,
      timeline: [
        ...current.progress.timeline,
        {
          sequence: event.sequence,
          eventId: event.id,
          phase: status,
          label: labelForEvent(event.type),
          at: event.timestamp
        }
      ].slice(-200)
    }
  });
}

/** Streams live run updates while preserving session boundaries and requesting resync when needed. */
export function openRunEventStream(
  input: Readonly<{
    detail: RunDetailResponse;
    generation: number;
    currentGeneration: () => number;
    createSource: (url: string) => RunStreamSource;
    registerStream: (source: RunStreamSource) => () => void;
    onEvent: (event: unknown) => void;
    onConnection: (state: ConnectionState) => void;
    onResync: () => void;
  }>
): () => void {
  if (input.detail.terminal) return () => undefined;
  const query =
    input.detail.watermark === null ? '' : `?after=${encodeURIComponent(input.detail.watermark)}`;
  const source = input.createSource(
    `/api/runs/${encodeURIComponent(input.detail.runId)}/events${query}`
  );
  const unregister = input.registerStream(source);
  let closed = false;
  const accepts = (): boolean => input.currentGeneration() === input.generation && !closed;
  const handleEvent = (message: MessageEvent<string>): void => {
    if (!accepts()) return;
    try {
      input.onEvent(JSON.parse(message.data) as unknown);
    } catch {
      // Invalid or partial network data is ignored; canonical state remains the REST projection.
    }
  };
  for (const type of runEventTypes) source.addEventListener(type, handleEvent);
  source.addEventListener('open', () => {
    if (accepts()) input.onConnection('connected');
  });
  source.addEventListener('error', () => {
    if (accepts()) input.onConnection('reconnecting');
  });
  source.addEventListener('stream.resync_required', (message) => {
    if (!accepts()) return;
    try {
      const instruction = runEventResyncInstructionSchema.parse(
        JSON.parse(message.data) as unknown
      );
      if (instruction.streamId === input.detail.runId) input.onResync();
    } catch {
      // A malformed control envelope cannot alter or disclose cached run state.
    }
  });
  return () => {
    if (closed) return;
    closed = true;
    unregister();
    source.close();
  };
}

/** Derives the run status the interface should show for an event. */
function statusForEvent(event: RunEventEnvelope, fallback: RunStatus): RunStatus {
  if ('status' in event.payload && typeof event.payload.status === 'string') {
    const parsed = runStatusSchema.safeParse(event.payload.status);
    if (parsed.success) return parsed.data;
  }
  const mapped = runStatusSchema.safeParse(runEventFallbackStatuses[event.type]);
  return mapped.success ? mapped.data : fallback;
}

/** Provides the user-facing timeline label for a run event. */
export function labelForEvent(type: RunEventEnvelope['type']): string {
  const labels: Partial<Record<RunEventEnvelope['type'], string>> = {
    run_created: 'Run created',
    start: 'Retrieving authorized evidence',
    retrieval_completed: 'Evidence retrieval completed',
    specialists_completed: 'Specialist analysis completed',
    synthesis_completed: 'Brief synthesis completed',
    validation_completed: 'Brief validation completed',
    validation_requires_approval: 'Approval required',
    awaiting_approval: 'Awaiting approval',
    approval_entry_recorded: 'Approval recorded; quorum remains',
    approval_granted: 'Approval quorum satisfied',
    approval_rejected: 'Approval rejected',
    approval_subject_replaced: 'Edited brief submitted for approval',
    regeneration_requested: 'Brief regeneration requested',
    complete: 'Brief completed',
    fail: 'Run failed',
    progress: 'Run progress updated',
    checkpoint_committed: 'Progress checkpoint saved'
  };
  return labels[type] ?? 'Run updated';
}
