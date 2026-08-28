import { Controller, Get, Headers, Options, Post, Req, Res, UseGuards, Inject, HttpCode } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  authSessionResponseSchema, authenticatedMutationResponseSchema, csrfResponseSchema,
  logoutResponseSchema, personaListResponseSchema, selectPersonaRequestSchema,
  type SelectPersonaRequest
} from '@slacato/contracts';
import { z } from 'zod';
import { ZodBody, ZodResponse } from '../../common/wire/zod.decorators.js';
import { AuthService } from './auth.service.js';
import { AUTH_OPTIONS, type AuthModuleOptions } from './contracts.js';
import { applyCorsPreflightHeaders, BrowserOriginGuard } from './guard.js';

@Controller('api/auth')
@UseGuards(BrowserOriginGuard)
export class AuthController {
  public constructor(
    private readonly auth: AuthService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthModuleOptions
  ) {}

  @Get('personas')
  @ZodResponse(personaListResponseSchema)
  public listPersonas() { return this.auth.listPersonas(); }

  @Get('session')
  @ZodResponse(authSessionResponseSchema)
  public getSession(@Req() request: Request) { return this.auth.getSession(request); }

  @Get('csrf')
  @ZodResponse(csrfResponseSchema)
  public csrf(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.auth.bootstrapCsrf(request, response);
  }

  @Post('persona')
  @ZodResponse(authenticatedMutationResponseSchema)
  public selectPersona(
    @ZodBody(selectPersonaRequestSchema) input: SelectPersonaRequest,
    @Headers('x-csrf-token') csrfToken: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.auth.selectPersona(input, csrfToken, request, response);
  }

  @Post('logout')
  @ZodResponse(logoutResponseSchema)
  public logout(
    @Headers('x-csrf-token') csrfToken: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.auth.logout(csrfToken, request, response);
  }

  @Options(['persona', 'logout'])
  @HttpCode(204)
  @ZodResponse(z.undefined())
  public preflight(@Req() request: Request, @Res({ passthrough: true }) response: Response): undefined {
    applyCorsPreflightHeaders(request, response, this.options.allowedOrigins);
    return undefined;
  }
}
