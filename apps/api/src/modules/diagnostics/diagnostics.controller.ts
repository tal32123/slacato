import { Controller, Get, Inject } from '@nestjs/common';
import type { DemoDiagnosticsResponse } from '@slacato/contracts';
import { demoDiagnosticsResponseSchema } from '@slacato/contracts';
import { ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { DiagnosticsService } from './diagnostics.service.js';

/** Exposes authenticated operational diagnostics for the current principal. */
@Controller('api/diagnostics')
export class DiagnosticsController {
  /** Initializes the controller with its diagnostics service. */
  public constructor(
    @Inject(DiagnosticsService) private readonly diagnostics: DiagnosticsService
  ) {}

  /** Returns runtime health and approval authority diagnostics visible to the current principal. */
  @Get()
  @ZodResponse(demoDiagnosticsResponseSchema)
  public view(
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ): Promise<DemoDiagnosticsResponse> {
    return this.diagnostics.view(principal);
  }
}
