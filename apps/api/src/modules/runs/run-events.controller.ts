import { once } from 'node:events';
import { BadRequestException, Controller, Get, Inject, NotFoundException, Req, Res } from '@nestjs/common';
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

async function writeFrame(response: Response, frame: string): Promise<void> {
  if (response.writableEnded || response.destroyed) return;
  if (response.write(frame)) return;
  await Promise.race([once(response, 'drain'), once(response, 'close')]);
}

function eventFrame(event: RunEventEnvelope): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

@Controller('api/runs')
export class RunEventsController {
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
    if (await this.query.authorizeAndSnapshot(params.runId, actorId) === undefined) return opaqueNotFound();
    const cursor = headerCursor(request) ?? query.after;

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
    const heartbeat = setInterval(() => {
      if (!abort.signal.aborted && !response.writableEnded) response.write(': heartbeat\n\n');
    }, this.heartbeatMs);
    heartbeat.unref();

    try {
      for await (const event of this.bus.subscribe(params.runId, cursor, abort.signal)) {
        if (abort.signal.aborted) break;
        await writeFrame(response, eventFrame(event));
        if (TERMINAL_EVENT_TYPES[event.type] === true || event.payload.terminal === true) {
          response.end();
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof CursorExpiredError)) throw error;
      if (!abort.signal.aborted) {
        const instruction = runEventResyncInstructionSchema.parse({
          type: 'stream.resync_required',
          version: 1,
          streamId: params.runId,
          timestamp: new Date().toISOString(),
          payload: { reason: 'cursor_expired', snapshotPath: `/api/runs/${params.runId}` }
        });
        await writeFrame(response, `event: ${instruction.type}\ndata: ${JSON.stringify(instruction)}\n\n`);
        response.end();
      }
    } finally {
      clearInterval(heartbeat);
      request.off('aborted', stop);
      response.off('close', stop);
      abort.abort();
      if (!response.writableEnded && !response.destroyed) response.end();
    }
    return undefined;
  }
}
