import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AUTH_OPTIONS, PERSONA_DIRECTORY, type AuthModuleOptions } from './contracts.js';
import { ApplicationSecurityGuard } from './guard.js';

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
        { provide: APP_GUARD, useClass: ApplicationSecurityGuard }
      ],
      exports: [AuthService]
    };
  }
}
