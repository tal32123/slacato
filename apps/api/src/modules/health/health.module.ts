import {
  type DynamicModule,
  Module,
  type OnApplicationShutdown,
  type Provider
} from '@nestjs/common';
import type { ReadinessCheck, ReadinessDependencies } from '@slacato/core';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

const unavailable: ReadinessCheck = { isReady: async () => false };
const unavailableDependencies: ReadinessDependencies = {
  database: unavailable,
  migration: unavailable,
  redis: unavailable,
  index: unavailable,
  model: unavailable
};

export type HealthModuleOptions = Readonly<{
  readiness: ReadinessDependencies;
  close?: () => Promise<void>;
}>;

/** Releases health-only infrastructure clients during application shutdown. */
class ReadinessResourceShutdown implements OnApplicationShutdown {
  public constructor(private readonly close: () => Promise<void>) {}

  /** Closes resources owned by the health composition. */
  public onApplicationShutdown(): Promise<void> {
    return this.close();
  }
}

/** Configures the health endpoint with explicitly supplied readiness dependencies. */
@Module({})
export class HealthModule {
  /** Registers concrete probes, defaulting to fail-closed checks for partial test compositions. */
  public static register(options?: HealthModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: HealthService,
        useValue: new HealthService(options?.readiness ?? unavailableDependencies)
      },
      ...(options?.close === undefined
        ? []
        : [
            {
              provide: ReadinessResourceShutdown,
              useValue: new ReadinessResourceShutdown(options.close)
            }
          ])
    ];
    return {
      global: true,
      module: HealthModule,
      controllers: [HealthController],
      providers,
      exports: [HealthService]
    };
  }
}
