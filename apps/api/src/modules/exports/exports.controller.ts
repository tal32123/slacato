import { Controller, Get, Inject, InternalServerErrorException, NotFoundException, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { logger } from '@slacato/infrastructure';
import { z } from 'zod';
import { ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { BRIEF_EXPORT_SERVICE, type BriefExportService } from './exports.service.js';

const exportParamsSchema = z.object({
  runId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  format: z.enum(['json', 'markdown'])
}).strict();
type ExportParams = z.infer<typeof exportParamsSchema>;

@Controller('api/runs')
export class ExportsController {
  public constructor(@Inject(BRIEF_EXPORT_SERVICE) private readonly exports: BriefExportService) {}

  @Get(':runId/export/:format')
  @ZodResponse(z.string())
  public async download(
    @ZodParam(exportParamsSchema) params: ExportParams | Promise<ExportParams>,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ): Promise<string> {
    const resolved = await params;
    const correlationId = `export_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    let result;
    try {
      result = await this.exports.exportFinalized({
        actorId: request.auth!.persona.userId,
        runId: resolved.runId,
        format: resolved.format
      });
    } catch (error) {
      logger.error({
        event: 'brief_export_failed', correlationId, runId: resolved.runId, status: 'failed',
        durationMs: Date.now() - startedAt, errorCode: 'BRIEF_EXPORT_FAILED', err: error
      });
      throw new InternalServerErrorException({ code: 'INTERNAL_ERROR', message: 'The request could not be completed.' });
    }
    if (result === undefined) {
      logger.warn({
        event: 'brief_export_denied', correlationId, runId: resolved.runId, status: 'denied',
        durationMs: Date.now() - startedAt, errorCode: 'NOT_FOUND'
      });
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
    }

    const extension = result.format === 'json' ? 'json' : 'md';
    const filenameRunId = resolved.runId.replace(/[^A-Za-z0-9_-]/g, '_');
    response.set({
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="deal-brief-${filenameRunId}.${extension}"`,
      'Content-Type': result.format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Correlation-Id': correlationId
    });
    logger.info({
      event: 'brief_export_completed', correlationId, runId: resolved.runId, status: 'completed',
      durationMs: Date.now() - startedAt, format: result.format
    });
    return result.content;
  }
}
