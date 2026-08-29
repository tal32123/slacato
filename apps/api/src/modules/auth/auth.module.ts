import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import {
  AUTH_OPTIONS,
  type AuthModuleOptions,
  PERSONA_DIRECTORY,
  SESSION_REGISTRY,
  type SessionRegistry
} from './contracts.js';
import { ApplicationSecurityGuard } from './guard.js';

/** Tracks active authentication sessions in process when no external registry is configured. */
class InMemorySessionRegistry implements SessionRegistry {
  private readonly sessions = new Map<
    string,
    Readonly<{ userId: string; expiresAt: Date; revoked: boolean }>
  >();

  /** Records a session as active until its stated expiration time. */
  public async activate(
    input: Readonly<{ version: string; userId: string; expiresAt: Date }>
  ): Promise<void> {
    this.sessions.set(input.version, {
      userId: input.userId,
      expiresAt: input.expiresAt,
      revoked: false
    });
  }

  /** Marks a session as revoked so it can no longer authorize requests. */
  public async revoke(version: string): Promise<void> {
    const session = this.sessions.get(version);
    if (session !== undefined) this.sessions.set(version, { ...session, revoked: true });
  }

  /** Reports whether a session currently authorizes the specified user. */
  public async isActive(version: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(version);
    return (
      session !== undefined &&
      !session.revoked &&
      session.userId === userId &&
      session.expiresAt.getTime() > Date.now()
    );
  }
}

/** Configures the authentication services, controller, and application security guard. */
@Module({})
export class AuthModule {
  /** Registers authentication with the supplied persona directory and session options. */
  public static register(options: AuthModuleOptions): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      controllers: [AuthController],
      providers: [
        { provide: AUTH_OPTIONS, useValue: options },
        { provide: PERSONA_DIRECTORY, useValue: options.personaDirectory },
        {
          provide: SESSION_REGISTRY,
          useValue: options.sessionRegistry ?? new InMemorySessionRegistry()
        },
        AuthService,
        { provide: APP_GUARD, useClass: ApplicationSecurityGuard }
      ],
      exports: [AuthService]
    };
  }
}
