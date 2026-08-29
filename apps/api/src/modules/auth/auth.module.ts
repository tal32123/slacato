import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import {
  AUTH_OPTIONS, PERSONA_DIRECTORY, SESSION_REGISTRY,
  type AuthModuleOptions, type SessionRegistry
} from './contracts.js';
import { ApplicationSecurityGuard } from './guard.js';
class InMemorySessionRegistry implements SessionRegistry {
  private readonly sessions = new Map<string, Readonly<{ userId: string; expiresAt: Date; revoked: boolean }>>();

  public async activate(input: Readonly<{ version: string; userId: string; expiresAt: Date }>): Promise<void> {
    this.sessions.set(input.version, { userId: input.userId, expiresAt: input.expiresAt, revoked: false });
  }

  public async revoke(version: string): Promise<void> {
    const session = this.sessions.get(version);
    if (session !== undefined) this.sessions.set(version, { ...session, revoked: true });
  }

  public async isActive(version: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(version);
    return session !== undefined && !session.revoked && session.userId === userId && session.expiresAt.getTime() > Date.now();
  }
}


@Module({})
export class AuthModule {
  public static register(options: AuthModuleOptions): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      controllers: [AuthController],
      providers: [
        { provide: AUTH_OPTIONS, useValue: options },
        { provide: PERSONA_DIRECTORY, useValue: options.personaDirectory },
        { provide: SESSION_REGISTRY, useValue: options.sessionRegistry ?? new InMemorySessionRegistry() },
        AuthService,
        { provide: APP_GUARD, useClass: ApplicationSecurityGuard }
      ],
      exports: [AuthService]
    };
  }
}
