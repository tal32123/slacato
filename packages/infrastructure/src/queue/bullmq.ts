import { Queue, type JobsOptions } from 'bullmq';
import type { CommandQueue, WorkflowCommand } from '@slacato/core';

export const WORKFLOW_QUEUE_NAME = 'slacato-workflow';
export const WORKFLOW_DEAD_LETTER_QUEUE_NAME = 'slacato-workflow-dead-letter';
export type CommandInspection = Readonly<{
  state: 'live' | 'completed' | 'failed' | 'missing';
  attemptsMade: number;
  maxAttempts: number;
  exhausted: boolean;
}>;

/** BullMQ transport retaining terminal jobs so command IDs stay deduplicating. */
export class BullMqCommandQueue implements CommandQueue {
  public readonly queue: Queue<WorkflowCommand, void, 'workflow-command'>;

  public constructor(redisUrl: string, queueName = WORKFLOW_QUEUE_NAME) {
    this.queue = new Queue<WorkflowCommand, void, 'workflow-command'>(queueName, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: false,
        removeOnFail: false
      }
    });
  }

  public async publish(command: WorkflowCommand): Promise<void> {
    if (/^\d+$/.test(command.id) || command.id.includes(':')) throw new Error('Command ID is not a valid BullMQ job ID');
    const existing = await this.queue.getJob(command.id);
    if (existing !== undefined) {
      const inspection = await this.inspect(command.id);
      if (inspection.state === 'failed' && !inspection.exhausted) await existing.retry();
      return;
    }
    const options: JobsOptions = { jobId: command.id };
    await this.queue.add('workflow-command', command, options);
  }

  public async inspect(commandId: string): Promise<CommandInspection> {
    const job = await this.queue.getJob(commandId);
    if (job === undefined) return { state: 'missing', attemptsMade: 0, maxAttempts: 0, exhausted: false };
    const state = await job.getState();
    const maxAttempts = job.opts.attempts ?? 1;
    const attemptsMade = job.attemptsMade;
    if (state === 'waiting' || state === 'active' || state === 'delayed' || state === 'prioritized') return { state: 'live', attemptsMade, maxAttempts, exhausted: false };
    if (state === 'failed') {
      const unrecoverable = job.stacktrace?.some((entry) => entry.startsWith('UnrecoverableError')) ?? false;
      return { state, attemptsMade, maxAttempts, exhausted: unrecoverable || attemptsMade >= maxAttempts };
    }
    return { state: 'completed', attemptsMade, maxAttempts, exhausted: false };
  }

  public async state(commandId: string): Promise<CommandInspection['state']> { return (await this.inspect(commandId)).state; }

  public async isLive(commandId: string): Promise<boolean> { return (await this.state(commandId)) === 'live'; }

  public close(): Promise<void> { return this.queue.close(); }
}
