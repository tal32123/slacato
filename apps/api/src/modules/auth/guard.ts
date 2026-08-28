import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AUTH_OPTIONS, type AuthModuleOptions } from './contracts.js';
import { AuthService } from './auth.service.js';
import { BrowserRequestPolicy } from './session.js';

export type AuthenticatedRequest = Request & {
  auth?: Awaited<ReturnType<AuthService['requireSession']>>;
};

@Injectable()
export class BrowserOriginGuard implements CanActivate {
  private readonly policy: BrowserRequestPolicy;

  public constructor(@Inject(AUTH_OPTIONS) options: AuthModuleOptions) {
    this.policy = new BrowserRequestPolicy(options.allowedOrigins);
  }

  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const result = this.policy.evaluate({
      method: request.method,
      origin: header(request, 'origin'),
      secFetchSite: header(request, 'sec-fetch-site')
    });
    if (!result.allowed) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Request could not be authorized' });
    if (result.origin !== undefined) applyCorsPreflightHeaders(request, response, [result.origin]);
    return true;
  }
}

@Injectable()
export class DemoAuthGuard implements CanActivate {
  public constructor(private readonly auth: AuthService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    try {
      request.auth = await this.auth.requireSession(request);
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Authentication is required' });
    }
  }
}

export function applyCorsPreflightHeaders(request: Request, response: Response, allowedOrigins: readonly string[]): void {
  const origin = header(request, 'origin');
  if (origin === undefined || !allowedOrigins.includes(origin)) return;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
  response.setHeader('Vary', 'Origin');
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
