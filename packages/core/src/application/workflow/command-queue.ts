import type { RunId } from '../../domain/shared/ids.js';

/** Durable, idempotent command payload. Delivery transports must not add business state. */
export type WorkflowCommand = Readonly<{
  id: string;
  runId: RunId;
  type: string;
  payload: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
}>;

/** Generic command-delivery seam; queue technology remains outside core. */
export interface CommandQueue {
  publish(command: WorkflowCommand): Promise<void>;
}
