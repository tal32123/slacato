import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService, type ReadinessCheck } from './health.service.js';

class UnconfiguredReadinessCheck implements ReadinessCheck {
  public async isReady(): Promise<boolean> { return false; }
}

@Module({
  controllers: [HealthController],
  providers: [{
    provide: HealthService,
    useFactory: () => {
      const unavailable = new UnconfiguredReadinessCheck();
      return new HealthService({ database: unavailable, migration: unavailable, redis: unavailable, index: unavailable, model: unavailable });
    }
  }],
  exports: [HealthService]
})
export class HealthModule {}
