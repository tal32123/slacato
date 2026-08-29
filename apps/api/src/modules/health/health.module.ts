import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService, type ReadinessCheck } from './health.service.js';

/** Reports readiness as unconfigured when no infrastructure checks have been registered. */
class UnconfiguredReadinessCheck implements ReadinessCheck {
  /** Reports that readiness checks have not yet been configured. */
  public async isReady(): Promise<'unconfigured'> { return 'unconfigured'; }
}

/** Configures the health endpoint and its default readiness service wiring. */
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
