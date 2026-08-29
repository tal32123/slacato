import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService, type ReadinessCheck } from './health.service.js';

class UnconfiguredReadinessCheck implements ReadinessCheck {
  public async isReady(): Promise<'unconfigured'> { return 'unconfigured'; }
}

@Module({
  controllers: [HealthController],
  providers: [{
    provide: HealthService,
    useFactory: () => {
      const unconfigured = new UnconfiguredReadinessCheck();
      return new HealthService({ database: unconfigured, migration: unconfigured, redis: unconfigured, index: unconfigured, model: unconfigured });
    }
  }],
  exports: [HealthService]
})
export class HealthModule {}
