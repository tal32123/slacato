import type { ProcessDealBriefStep, WorkflowCommand } from '@slacato/core';
import { type Job, Worker } from 'bullmq';
import { logger } from '../logging/logger.js';
import { WORKFLOW_QUEUE_NAME } from '../queue/bullmq.js';

export type DealBriefProcessorOptions = Readonly<{
  redisUrl: string;
  workerId: string;
  concurrency?: number;
  jobsPerSecond?: number;
  lockDurationMs?: number;
}>;

/** Delivers BullMQ workflow commands and records their execution outcome. */
export class DealBriefProcessor {
  private readonly worker: Worker<WorkflowCommand, void, 'workflow-command'>;

  /** Starts a single-concurrency BullMQ consumer with bounded delivery rate and lock renewal. */
  public constructor(processStep: ProcessDealBriefStep, options: DealBriefProcessorOptions) {
    const concurrency = options.concurrency ?? 1;
    const jobsPerSecond = options.jobsPerSecond ?? 2;
    const lockDuration = options.lockDurationMs ?? 120_000;
    if (!Number.isInteger(concurrency) || concurrency !== 1) {
      throw new RangeError('Initial deal brief worker concurrency must be exactly one');
    }
    if (!Number.isInteger(jobsPerSecond) || jobsPerSecond < 1) {
      throw new RangeError('Worker rate limit must be positive');
    }

    this.worker = new Worker<WorkflowCommand, void, 'workflow-command'>(
      WORKFLOW_QUEUE_NAME,
      (job) => this.processDeliveredCommand(job, processStep, options.workerId),
      {
        connection: { url: options.redisUrl },
        concurrency,
        limiter: { max: jobsPerSecond, duration: 1_000 },
        lockDuration,
        lockRenewTime: Math.max(1_000, Math.floor(lockDuration / 3)),
        autorun: true
      }
    );
  }

  /** Pauses delivery before closing the BullMQ consumer without forcing active work to stop. */
  public async close(): Promise<void> {
    await this.worker.pause(true);
    await this.worker.close(false);
  }

  /** Executes one delivered workflow command and logs its start, completion, or failure. */
  private async processDeliveredCommand(
    job: Job<WorkflowCommand, void, 'workflow-command'>,
    processStep: ProcessDealBriefStep,
    workerId: string
  ): Promise<void> {
    const startedAt = Date.now();
    const correlationId = String(job.id ?? job.data.id);
    const attempt = job.attemptsMade + 1;
    logger.info({
      event: 'workflow_command_started',
      correlationId,
      runId: job.data.runId,
      attemptId: job.data.id,
      status: 'started',
      durationMs: 0,
      retryCount: job.attemptsMade
    });

    try {
      await processStep.execute({ command: job.data, workerId });
      logger.info({
        event: 'workflow_command_completed',
        correlationId,
        runId: job.data.runId,
        attemptId: job.data.id,
        status: 'completed',
        durationMs: Date.now() - startedAt,
        retryCount: attempt - 1
      });
    } catch (error) {
      logger.error({
        event: 'workflow_command_failed',
        correlationId,
        runId: job.data.runId,
        attemptId: job.data.id,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        retryCount: attempt - 1,
        step: typeof job.data.payload.step === 'string' ? job.data.payload.step : 'unknown',
        errorName: error instanceof Error ? error.constructor.name : 'UnknownError',
        errorCode: 'WORKFLOW_COMMAND_FAILED'
      });
      throw error;
    }
  }
}
