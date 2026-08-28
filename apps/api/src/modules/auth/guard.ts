import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ENDPOINT_ACCESS, type EndpointAccess } from '../../common/security/access.metadata.js';
import { AUTH_OPTIONS, type AuthModuleOptions } from './contracts.js';
import { AuthService } from './auth.service.js';
import { BrowserRequestPolicy } from './session.js';

export type AuthenticatedRequest = Request & {
  auth?: Awaited<ReturnType<AuthService['requireSession']>>;
};

/** Default-on browser provenance, authentication, and mutation-CSRF enforcement. */
@Injectable()
export class ApplicationSecurityGuard implements CanActivate {
  private readonly policy: BrowserRequestPolicy;

  public constructor(
    @Inject(AUTH_OPTIONS) options: AuthModuleOptions,
    private readonly reflector: Reflector,
    private readonly auth: AuthService
  ) {
    this.policy = new BrowserRequestPolicy(options.allowedOrigins);
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<EndpointAccess>(ENDPOINT_ACCESS, [context.getHandler(), context.getClass()]);
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();
    if (access === 'non_browser_public') {
      if (['GET', 'HEAD'].includes(request.method.toUpperCase())) return true;
      this.forbidden();
    }
    const provenance = this.policy.evaluate({
      method: request.method,
      origin: header(request, 'origin'),
      secFetchSite: header(request, 'sec-fetch-site')
    });
    if (!provenance.allowed) this.forbidden();
    if (provenance.origin !== undefined) applyCorsHeaders(request, response, [provenance.origin]);
    if (request.method.toUpperCase() === 'OPTIONS') return true;

    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());
    const token = header(request, 'x-csrf-token');
    if (access === 'browser_public') {
      if (mutation) await this.auth.assertPublicMutationCsrf(request, token);
      return true;
    }

    const session = await this.auth.requireSession(request);
    request.auth = session;
    if (mutation) this.auth.assertAuthenticatedMutationCsrf(request, token, session.claims.version);
    return true;
  }

  private forbidden(): never {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Request could not be authorized' });
  }
}

export function applyCorsHeaders(request: Request, response: Response, allowedOrigins: readonly string[]): void {
  const origin = header(request, 'origin');
  if (origin === undefined || !allowedOrigins.includes(origin)) return;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
  response.setHeader('Vary', 'Origin');
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
