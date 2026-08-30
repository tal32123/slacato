import {
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Res
} from '@nestjs/common';
import { opaqueIdSchema } from '@slacato/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodParam, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import {
  BRIEF_EXPORT_SERVICE,
  type BriefExportResult,
  type BriefExportService
} from './contracts.js';

const exportParamsSchema = z
  .object({
    runId: opaqueIdSchema,
    format: z.enum(['json', 'markdown'])
  })
  .strict();
type ExportParams = z.infer<typeof exportParamsSchema>;

/** Serves finalized run briefs as authenticated file downloads. */
@Controller('api/runs')
export class ExportsController {
  private readonly logger = new Logger(ExportsController.name);
  /** Creates a controller backed by the brief export service. */
  public constructor(@Inject(BRIEF_EXPORT_SERVICE) private readonly exports: BriefExportService) {}

  /** Exports a finalized run in the requested format with download-safe headers. */
  @Get(':runId/export/:format')
  @ZodResponse(z.string())
  public async download(
    @ZodParam(exportParamsSchema) params: ExportParams | Promise<ExportParams>,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Res({ passthrough: true }) response: Response
  ): Promise<string> {
    const resolved = await params;
    const correlationId = `export_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    let result: BriefExportResult | undefined;
    try {
      result = await this.exports.exportFinalized({
        actorId: principal.persona.userId,
        runId: resolved.runId,
        format: resolved.format
      });
    } catch (_error) {
      this.logger.error({
        event: 'brief_export_failed',
        correlationId,
        runId: resolved.runId,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: 'BRIEF_EXPORT_FAILED'
      });
      throw new InternalServerErrorException({
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.'
      });
    }
    if (result === undefined) {
      this.logger.warn({
        event: 'brief_export_denied',
        correlationId,
        status: 'denied',
        durationMs: Date.now() - startedAt,
        errorCode: 'NOT_FOUND'
      });
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.'
      });
    }

    const extension = result.format === 'json' ? 'json' : 'md';
    const filenameRunId = resolved.runId.replace(/[^A-Za-z0-9_-]/g, '_');
    response.set({
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="deal-brief-${filenameRunId}.${extension}"`,
      'Content-Type':
        result.format === 'json'
          ? 'application/json; charset=utf-8'
          : 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Correlation-Id': correlationId
    });
    this.logger.log({
      event: 'brief_export_completed',
      correlationId,
      runId: resolved.runId,
      status: 'completed',
      durationMs: Date.now() - startedAt
    });
    return result.content;
  }
}
