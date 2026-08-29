import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { liveHealthSchema, readinessHealthSchema } from '@slacato/contracts';
import type { Response } from 'express';
import { NonBrowserPublic } from '../../common/security/access.metadata.js';
import { ZodResponse } from '../../common/wire/zod.decorators.js';
import { HealthService, type ReadinessHealth } from './health.service.js';

/** Reports application liveness and dependency readiness to infrastructure health checks. */
@Controller('api/health')
@NonBrowserPublic()
export class HealthController {
  /** Creates a health controller backed by the readiness health service. */
  public constructor(private readonly health: HealthService) {}

  /** Reports whether the API process is running. */
  @Get('live')
  @ZodResponse(liveHealthSchema)
  public async live(): Promise<{ status: 'live' }> {
    return { status: 'live' };
  }

  /** Reports whether required dependencies are ready to serve traffic. */
  @Get('ready')
  @ZodResponse(readinessHealthSchema)
  public async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessHealth> {
    const health = await this.health.readiness();
    response.status(health.status === 'ready' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return health;
  }
}
