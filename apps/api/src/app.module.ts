import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ApiWireBoundaryMiddleware } from './common/wire/api-wire-boundary.middleware.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({ imports: [HealthModule] })
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ApiWireBoundaryMiddleware).forRoutes('*');
  }
}
