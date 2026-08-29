import { BadRequestException, Controller, Get, HttpException, HttpStatus, Inject, NotFoundException, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  opaqueIdSchema,
  runEventCursorSchema,
  runEventResyncInstructionSchema,
  runSnapshotSchema,
  terminalRunEventTypes,
  type RunEventEnvelope
} from '@slacato/contracts';
import { CursorExpiredError, type RunEventBus, type RunEventQuery } from '@slacato/core';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { AuthService } from '../auth/auth.service.js';
import { ZodParam, ZodQuery, ZodResponse } from '../../common/wire/zod.decorators.js';
import { RUN_EVENT_BUS, RUN_EVENT_HEARTBEAT_MS, RUN_EVENT_QUERY } from './contracts.js';

const paramsSchema = z.object({ runId: opaqueIdSchema }).strict();
const querySchema = z.object({ after: runEventCursorSchema.optional() }).strict();
type RunParams = z.infer<typeof paramsSchema>;
type EventsQuery = z.infer<typeof querySchema>;
const MAX_STREAMS_PER_ACTOR = 4;
const MAX_STREAMS_PER_ACTOR_RUN = 2;

/** Hides whether a requested run exists or is merely inaccessible. */
function opaqueNotFound(): never {
  throw new NotFoundException({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
}

/** Reads and validates an SSE resume cursor from the request headers. */
function headerCursor(request: Request): string | undefined {
  const raw = request.headers['last-event-id'];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Event cursor is invalid' });
  const parsed = runEventCursorSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Event cursor is invalid' });
  return parsed.data;
}

/** Serializes SSE frames while respecting response backpressure. */
class SerializedSseWriter {
  private tail = Promise.resolve();

  public constructor(private readonly response: Response) {}

  /** Enqueues one SSE frame for ordered delivery. */
  public write(frame: string): Promise<void> {
    const written = this.tail.then(() => this.writeNow(frame));
    this.tail = written.catch(() => undefined);
    return written;
  }

  /** Writes a frame once the preceding write has completed. */
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

/** Encodes a run event as an SSE frame. */
function eventFrame(event: RunEventEnvelope): string {
  const safe = runEventCursorSchema.parse(event.id);
  return `id: ${safe}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Serves authorized run snapshots and resumable event streams. */
@Controller('api/runs')
export class RunEventsController {
  private readonly actorStreams = new Map<string, number>();
  private readonly actorRunStreams = new Map<string, number>();

  public constructor(
    @Inject(RUN_EVENT_BUS) private readonly bus: RunEventBus,
    @Inject(RUN_EVENT_QUERY) private readonly query: RunEventQuery,
    @Inject(RUN_EVENT_HEARTBEAT_MS) private readonly heartbeatMs: number,
    private readonly auth: AuthService
  ) {}

  /** Returns the caller-authorized snapshot for a run. */
  @Get(':runId')
  @ZodResponse(runSnapshotSchema)
  public async snapshot(
    @ZodParam(paramsSchema) params: RunParams,
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ) {
    const actorId = principal.persona.userId;
    const snapshot = await this.query.authorizeAndSnapshot(params.runId, actorId);
    if (snapshot === undefined) return opaqueNotFound();
    return snapshot;
  }

  /** Streams authorized run events while continuously revalidating the session. */
  @Get(':runId/events')
  @ZodResponse(z.undefined())
  public async events(
    @ZodParam(paramsSchema) params: RunParams,
    @ZodQuery(querySchema) query: EventsQuery,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: Request,
    @Res() response: Response
  ): Promise<undefined> {
    const actorId = principal.persona.userId;
    const sessionVersion = principal.claims.version;
    const authorize = async (): Promise<boolean> =>
      await this.auth.isSessionActive(sessionVersion, actorId)
      && await this.query.authorizeAndSnapshot(params.runId, actorId) !== undefined;
    const snapshot = await this.query.authorizeAndSnapshot(params.runId, actorId);
    if (snapshot === undefined || !await this.auth.isSessionActive(sessionVersion, actorId)) return opaqueNotFound();
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
      void authorize().then(async (allowed) => {
        if (!allowed) {
          abort.abort();
          response.end();
          return;
        }
        await writer.write(': heartbeat\n\n');
      }).catch(() => {
        abort.abort();
        response.end();
      }).finally(() => { heartbeatPending = false; });
    }, this.heartbeatMs);
    heartbeat.unref();

    try {
      for await (const event of this.bus.subscribe(params.runId, cursor, abort.signal, authorize)) {
        if (abort.signal.aborted) break;
        if (!await authorize()) {
          response.end();
          break;
        }
        await writer.write(eventFrame(event));
        if (terminalRunEventTypes.includes(event.type) || ('terminal' in event.payload && event.payload.terminal === true)) {
          response.end();
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof CursorExpiredError)) throw error;
      if (!abort.signal.aborted && await authorize()) {
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

  /** Reserves one actor/run stream slot and returns an idempotent release callback. */
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
