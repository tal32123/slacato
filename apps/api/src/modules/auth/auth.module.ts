import { DynamicModule, Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AUTH_OPTIONS, PERSONA_DIRECTORY, type AuthModuleOptions } from './contracts.js';
import { BrowserOriginGuard, DemoAuthGuard } from './guard.js';

@Module({})
export class AuthModule {
  public static register(options: AuthModuleOptions): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [
        { provide: AUTH_OPTIONS, useValue: options },
        { provide: PERSONA_DIRECTORY, useValue: options.personaDirectory },
        AuthService,
        BrowserOriginGuard,
        DemoAuthGuard
      ],
      exports: [AuthService, DemoAuthGuard]
    };
  }
}
