import { Controller, Get, HttpCode, UseInterceptors } from '@nestjs/common';
import { liveHealthSchema, readinessHealthSchema } from '@slacato/contracts';
import { ZodResponseInterceptor } from '../../common/wire/zod-response.interceptor.js';
import { HealthService, type ReadinessHealth } from './health.service.js';

@Controller('api/health')
export class HealthController {
  public constructor(private readonly health: HealthService) {}

  @Get('live')
  @HttpCode(200)
  @UseInterceptors(new ZodResponseInterceptor(liveHealthSchema))
  public async live(): Promise<{ status: 'live' }> {
    return { status: 'live' };
  }

  @Get('ready')
  @UseInterceptors(new ZodResponseInterceptor(readinessHealthSchema))
  public async ready(): Promise<ReadinessHealth> {
    return this.health.readiness();
  }
}
