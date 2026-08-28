import { Queue, type JobsOptions } from 'bullmq';
import type { CommandQueue, WorkflowCommand } from '@slacato/core';

export const WORKFLOW_QUEUE_NAME = 'slacato-workflow';

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
    const options: JobsOptions = { jobId: command.id };
    await this.queue.add('workflow-command', command, options);
  }

  public async state(commandId: string): Promise<'live' | 'terminal' | 'missing'> {
    const job = await this.queue.getJob(commandId);
    if (job === undefined) return 'missing';
    const state = await job.getState();
    return state === 'waiting' || state === 'active' || state === 'delayed' || state === 'prioritized' ? 'live' : 'terminal';
  }

  public async isLive(commandId: string): Promise<boolean> { return (await this.state(commandId)) === 'live'; }

  public close(): Promise<void> { return this.queue.close(); }
}
