import { type DynamicModule, Module } from '@nestjs/common';
import { RESET_SANDBOX, type SandboxModuleOptions } from './contracts.js';
import { SandboxController } from './sandbox.controller.js';

/**
 * Registers the sandbox reset routes, and is itself registered only for a designated sandbox.
 *
 * There is no disabled state to configure here. A deployment that did not opt in never constructs
 * this module, so the routes it owns do not exist in that process - which is a stronger guarantee
 * than a flag the handlers consult, and the reason the interface can decide whether to render a
 * destructive control purely from whether the capability answers.
 */
@Module({})
export class SandboxModule {
  /** Builds the sandbox module around a reset command already bound to the sandbox database. */
  public static register(options: SandboxModuleOptions): DynamicModule {
    return {
      module: SandboxModule,
      controllers: [SandboxController],
      providers: [{ provide: RESET_SANDBOX, useValue: options.resetSandbox }]
    };
  }
}
