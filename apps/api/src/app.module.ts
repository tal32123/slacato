import { DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import type { AuthModuleOptions } from './modules/auth/contracts.js';

@Module({})
export class AppModule {
  public static register(auth: AuthModuleOptions): DynamicModule {
    return { module: AppModule, imports: [HealthModule, AuthModule.register(auth)] };
  }
}
