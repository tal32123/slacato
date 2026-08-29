import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import type { DemoDiagnosticsResponse } from '@slacato/contracts';
import { demoDiagnosticsResponseSchema } from '@slacato/contracts';
import { ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { DiagnosticsService } from './diagnostics.service.js';

@Controller('api/diagnostics')
export class DiagnosticsController {
  public constructor(private readonly diagnostics: DiagnosticsService) {}

  @Get()
  @ZodResponse(demoDiagnosticsResponseSchema)
  public view(@Req() request: AuthenticatedRequest): Promise<DemoDiagnosticsResponse> {
    if (request.auth === undefined) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Authentication is required' });
    }
    return this.diagnostics.view(request.auth);
  }
}
