import { BadRequestException, Controller, Get, HttpException, HttpStatus, Inject, NotFoundException, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  runEventCursorSchema,
  runEventResyncInstructionSchema,
  runSnapshotSchema,
  type RunEventEnvelope
} from '@slacato/contracts';
import { CursorExpiredError, type RunEventBus, type RunEventQuery } from '@slacato/core';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { ZodParam, ZodQuery, ZodResponse } from '../../common/wire/zod.decorators.js';
import { RUN_EVENT_BUS, RUN_EVENT_HEARTBEAT_MS, RUN_EVENT_QUERY } from './contracts.js';

const paramsSchema = z.object({ runId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict();
const querySchema = z.object({ after: runEventCursorSchema.optional() }).strict();
type RunParams = z.infer<typeof paramsSchema>;
type EventsQuery = z.infer<typeof querySchema>;
const TERMINAL_EVENT_TYPES: Readonly<Record<string, true>> = { complete: true, fail: true, approval_rejected: true };
const MAX_STREAMS_PER_ACTOR = 4;
const MAX_STREAMS_PER_ACTOR_RUN = 2;

function opaqueNotFound(): never {
  throw new NotFoundException({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
}

function headerCursor(request: Request): string | undefined {
  const raw = request.headers['last-event-id'];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Event cursor is invalid' });
  const parsed = runEventCursorSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Event cursor is invalid' });
  return parsed.data;
}

class SerializedSseWriter {
  private tail = Promise.resolve();

  public constructor(private readonly response: Response) {}

  public write(frame: string): Promise<void> {
    const written = this.tail.then(() => this.writeNow(frame));
    this.tail = written.catch(() => undefined);
    return written;
  }

  private async writeNow(frame: string): Promise<void> {
    if (this.response.writableEnded || this.response.destroyed) return;
    if (this.response.write(frame)) return;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const cleanup = (): void => {
      this.response.off('drain', onDrain);
      this.response.off('close', onClose);
    };
    const onDrain = (): void => { cleanup(); resolveReady(); };
    const onClose = (): void => { cleanup(); resolveReady(); };
    this.response.once('drain', onDrain);
    this.response.once('close', onClose);
    if (this.response.writableEnded || this.response.destroyed) onClose();
    await ready;
  }
}

function eventFrame(event: RunEventEnvelope): string {
  const safe = runEventCursorSchema.parse(event.id);
  return `id: ${safe}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

@Controller('api/runs')
export class RunEventsController {
  private readonly actorStreams = new Map<string, number>();
  private readonly actorRunStreams = new Map<string, number>();

  public constructor(
    @Inject(RUN_EVENT_BUS) private readonly bus: RunEventBus,
    @Inject(RUN_EVENT_QUERY) private readonly query: RunEventQuery,
    @Inject(RUN_EVENT_HEARTBEAT_MS) private readonly heartbeatMs: number
  ) {}

  @Get(':runId')
  @ZodResponse(runSnapshotSchema)
  public async snapshot(@ZodParam(paramsSchema) params: RunParams, @Req() request: AuthenticatedRequest) {
    const actorId = request.auth?.persona.userId;
    if (actorId === undefined) throw new Error('Authenticated request identity was not installed');
    const snapshot = await this.query.authorizeAndSnapshot(params.runId, actorId);
    if (snapshot === undefined) return opaqueNotFound();
    return snapshot;
  }

  @Get(':runId/events')
  @ZodResponse(z.undefined())
  public async events(
    @ZodParam(paramsSchema) params: RunParams,
    @ZodQuery(querySchema) query: EventsQuery,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response
  ): Promise<undefined> {
    const actorId = request.auth?.persona.userId;
    if (actorId === undefined) throw new Error('Authenticated request identity was not installed');
    const snapshot = await this.query.authorizeAndSnapshot(params.runId, actorId);
    if (snapshot === undefined) return opaqueNotFound();
    const cursor = headerCursor(request) ?? query.after;
    if (snapshot.terminal && (cursor === undefined || cursor === snapshot.watermark)) {
      response.status(204).end();
      return undefined;
    }
    const releaseStream = this.acquireStream(actorId, params.runId);

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.flushHeaders();

    const abort = new AbortController();
    const stop = (): void => abort.abort();
    request.once('aborted', stop);
    response.once('close', stop);
    const writer = new SerializedSseWriter(response);
    let heartbeatPending = false;
    const heartbeat = setInterval(() => {
      if (abort.signal.aborted || response.writableEnded || heartbeatPending) return;
      heartbeatPending = true;
      void writer.write(': heartbeat\n\n').finally(() => { heartbeatPending = false; });
    }, this.heartbeatMs);
    heartbeat.unref();

    try {
      for await (const event of this.bus.subscribe(params.runId, cursor, abort.signal)) {
        if (abort.signal.aborted) break;
        if (await this.query.authorizeAndSnapshot(params.runId, actorId) === undefined) {
          response.end();
          break;
        }
        await writer.write(eventFrame(event));
        if (TERMINAL_EVENT_TYPES[event.type] === true || ('terminal' in event.payload && event.payload.terminal === true)) {
          response.end();
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof CursorExpiredError)) throw error;
      if (!abort.signal.aborted) {
        const instruction = runEventResyncInstructionSchema.parse({
          type: 'stream.resync_required', version: 1, streamId: params.runId,
          timestamp: new Date().toISOString(),
          payload: { reason: 'cursor_expired', snapshotPath: `/api/runs/${params.runId}` }
        });
        await writer.write(`event: ${instruction.type}\ndata: ${JSON.stringify(instruction)}\n\n`);
        response.end();
      }
    } finally {
      clearInterval(heartbeat);
      request.off('aborted', stop);
      response.off('close', stop);
      abort.abort();
      releaseStream();
      if (!response.writableEnded && !response.destroyed) response.end();
    }
    return undefined;
  }

  private acquireStream(actorId: string, runId: string): () => void {
    const actorRunKey = `${actorId}\u0000${runId}`;
    const actorCount = this.actorStreams.get(actorId) ?? 0;
    const actorRunCount = this.actorRunStreams.get(actorRunKey) ?? 0;
    if (actorCount >= MAX_STREAMS_PER_ACTOR || actorRunCount >= MAX_STREAMS_PER_ACTOR_RUN) {
      throw new HttpException({ code: 'STREAM_LIMIT', message: 'Too many active run streams' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.actorStreams.set(actorId, actorCount + 1);
    this.actorRunStreams.set(actorRunKey, actorRunCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextActorCount = (this.actorStreams.get(actorId) ?? 1) - 1;
      const nextActorRunCount = (this.actorRunStreams.get(actorRunKey) ?? 1) - 1;
      if (nextActorCount === 0) this.actorStreams.delete(actorId); else this.actorStreams.set(actorId, nextActorCount);
      if (nextActorRunCount === 0) this.actorRunStreams.delete(actorRunKey); else this.actorRunStreams.set(actorRunKey, nextActorRunCount);
    };
  }
}
