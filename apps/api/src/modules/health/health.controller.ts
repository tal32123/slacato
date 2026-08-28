import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { liveHealthSchema, readinessHealthSchema } from '@slacato/contracts';
import type { Response } from 'express';
import { ZodResponse } from '../../common/wire/zod.decorators.js';
import { HealthService, type ReadinessHealth } from './health.service.js';

@Controller('api/health')
export class HealthController {
  public constructor(private readonly health: HealthService) {}

  @Get('live')
  @ZodResponse(liveHealthSchema)
  public async live(): Promise<{ status: 'live' }> {
    return { status: 'live' };
  }

  @Get('ready')
  @ZodResponse(readinessHealthSchema)
  public async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessHealth> {
    const health = await this.health.readiness();
    response.status(health.status === 'ready' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return health;
  }
}
