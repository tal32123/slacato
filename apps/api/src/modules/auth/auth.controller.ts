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

@Controller('api/auth')
export class AuthController {
  public constructor(
    private readonly auth: AuthService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthModuleOptions
  ) {}

  @Get('personas')
  @BrowserPublic()
  @ZodResponse(personaListResponseSchema)
  public listPersonas() { return this.auth.listPersonas(); }

  @Get('session')
  @BrowserPublic()
  @ZodResponse(authSessionResponseSchema)
  public getSession(@Req() request: Request) { return this.auth.getSession(request); }

  @Get('csrf')
  @BrowserPublic()
  @ZodResponse(csrfResponseSchema)
  public csrf(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.auth.bootstrapCsrf(request, response);
  }

  @Post('persona')
  @BrowserPublic()
  @ZodResponse(authenticatedMutationResponseSchema)
  public selectPersona(
    @ZodBody(selectPersonaRequestSchema) input: SelectPersonaRequest,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.auth.selectPersona(input, response);
  }

  @Post('logout')
  @ZodResponse(logoutResponseSchema)
  public logout(
    @Res({ passthrough: true }) response: Response
  ) {
    return this.auth.logout(response);
  }

  @Options(['persona', 'logout'])
  @BrowserPublic()
  @HttpCode(204)
  @ZodResponse(z.undefined())
  public preflight(@Req() request: Request, @Res({ passthrough: true }) response: Response): undefined {
    applyCorsHeaders(request, response, this.options.allowedOrigins);
    return undefined;
  }
}
