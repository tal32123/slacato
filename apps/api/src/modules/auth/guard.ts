import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ENDPOINT_ACCESS, type EndpointAccess } from '../../common/security/access.metadata.js';
import { AuthService } from './auth.service.js';
import {
  AUTH_OPTIONS,
  type AuthenticatedPrincipal,
  type AuthModuleOptions,
  type PrincipalAwareRequest
} from './contracts.js';
import { BrowserRequestPolicy } from './session.js';

type SecurityGuardRequest = Request & PrincipalAwareRequest;

/** Default-on browser provenance, authentication, and mutation-CSRF enforcement. */
@Injectable()
export class ApplicationSecurityGuard implements CanActivate {
  private readonly policy: BrowserRequestPolicy;

  /** Initializes the guard with its authentication policy dependencies. */
  public constructor(
    @Inject(AUTH_OPTIONS) options: AuthModuleOptions,
    private readonly reflector: Reflector,
    private readonly auth: AuthService
  ) {
    this.policy = new BrowserRequestPolicy(options.allowedOrigins);
  }

  /** Enforces endpoint access policy and installs the principal consumed by protected handlers. */
  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<EndpointAccess>(ENDPOINT_ACCESS, [
      context.getHandler(),
      context.getClass()
    ]);
    const http = context.switchToHttp();
    const request = http.getRequest<SecurityGuardRequest>();
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

    const principal: AuthenticatedPrincipal = await this.auth.requireSession(request);
    request.auth = principal;
    if (mutation)
      this.auth.assertAuthenticatedMutationCsrf(request, token, principal.claims.version);
    return true;
  }

  /** Rejects the current request with the standard forbidden response. */
  private forbidden(): never {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Request could not be authorized' });
  }
}

/** Applies credentialed CORS headers for an allowed request origin. */
export function applyCorsHeaders(
  request: Request,
  response: Response,
  allowedOrigins: readonly string[]
): void {
  const origin = header(request, 'origin');
  if (origin === undefined || !allowedOrigins.includes(origin)) return;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
  response.setHeader('Vary', 'Origin');
}

/** Returns the first value for a request header. */
function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
