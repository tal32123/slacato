import { Controller, Get, Options, Post, Req, Res, Inject, HttpCode } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  authSessionResponseSchema, authenticatedMutationResponseSchema, csrfResponseSchema,
  logoutResponseSchema, personaListResponseSchema, selectPersonaRequestSchema,
  type SelectPersonaRequest
} from '@slacato/contracts';
import { z } from 'zod';
import { ZodBody, ZodResponse } from '../../common/wire/zod.decorators.js';
import { BrowserPublic } from '../../common/security/access.metadata.js';
import { AuthService } from './auth.service.js';
import { AUTH_OPTIONS, type AuthModuleOptions } from './contracts.js';
import { applyCorsHeaders } from './guard.js';

/** Exposes browser authentication endpoints for persona selection, session state, CSRF bootstrapping, and logout. */
@Controller('api/auth')
export class AuthController {
  /** Creates the authentication controller with its service and allowed-origin configuration. */
  public constructor(
    private readonly auth: AuthService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthModuleOptions
  ) {}

  /** Lists the personas available for browser authentication. */
  @Get('personas')
  @BrowserPublic()
  @ZodResponse(personaListResponseSchema)
  public listPersonas() { return this.auth.listPersonas(); }

  /** Returns the current browser authentication session. */
  @Get('session')
  @BrowserPublic()
  @ZodResponse(authSessionResponseSchema)
  public getSession(@Req() request: Request) { return this.auth.getSession(request); }

  /** Bootstraps CSRF protection for the current browser session. */
  @Get('csrf')
  @BrowserPublic()
  @ZodResponse(csrfResponseSchema)
  public csrf(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.auth.bootstrapCsrf(request, response);
  }

  /** Selects a persona and establishes its authenticated browser session. */
  @Post('persona')
  @BrowserPublic()
  @ZodResponse(authenticatedMutationResponseSchema)
  public selectPersona(
    @ZodBody(selectPersonaRequestSchema) input: SelectPersonaRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.auth.selectPersona(input, request, response);
  }

  /** Ends the current authenticated browser session. */
  @Post('logout')
  @ZodResponse(logoutResponseSchema)
  public logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.auth.logout(request, response);
  }

  /** Applies CORS headers to supported authentication preflight requests. */
  @Options(['persona', 'logout'])
  @BrowserPublic()
  @HttpCode(204)
  @ZodResponse(z.undefined())
  public preflight(@Req() request: Request, @Res({ passthrough: true }) response: Response): undefined {
    applyCorsHeaders(request, response, this.options.allowedOrigins);
    return undefined;
  }
}
