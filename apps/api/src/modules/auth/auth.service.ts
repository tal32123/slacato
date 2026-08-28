import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthSessionResponse, Persona, SelectPersonaRequest } from '@slacato/contracts';
import { AUTH_OPTIONS, PERSONA_DIRECTORY, type AuthModuleOptions, type CanonicalPersonaDirectory } from './contracts.js';
import { DemoSessionCodec, SessionCsrf } from './session.js';
import { Inject } from '@nestjs/common';

const SESSION_COOKIE_DEV = 'slacato_session';
const CSRF_COOKIE_DEV = 'slacato_csrf_seed';
const SESSION_COOKIE_PROD = '__Host-slacato_session';
const CSRF_COOKIE_PROD = '__Host-slacato_csrf_seed';
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;

type CookieOptions = Readonly<{
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}>;

@Injectable()
export class AuthService {
  private readonly sessionCodec: DemoSessionCodec;
  private readonly csrf: SessionCsrf;

  public constructor(
    @Inject(AUTH_OPTIONS) private readonly options: AuthModuleOptions,
    @Inject(PERSONA_DIRECTORY) private readonly personas: CanonicalPersonaDirectory
  ) {
    this.sessionCodec = new DemoSessionCodec(options.sessionSecret);
    this.csrf = new SessionCsrf(options.sessionSecret);
  }

  public async listPersonas(): Promise<Readonly<{ personas: readonly Persona[] }>> {
    const personas = await this.personas.list();
    return { personas: personas.map(({ userId, displayName, role }) => ({ userId, displayName, role })) };
  }

  public async getSession(request: Request): Promise<AuthSessionResponse> {
    const resolved = await this.resolveSession(request);
    return resolved === undefined ? { authenticated: false } : {
      authenticated: true,
      persona: {
        userId: resolved.persona.userId,
        displayName: resolved.persona.displayName,
        role: resolved.persona.role
      },
      version: resolved.claims.version
    };
  }

  public async bootstrapCsrf(request: Request, response: Response): Promise<Readonly<{ csrfToken: string }>> {
    const session = await this.resolveSession(request);
    const seed = this.readCookie(request, this.csrfCookieName) ?? this.csrf.createSeed();
    this.writeCookie(response, this.csrfCookieName, seed);
    return { csrfToken: this.csrf.issue(seed, session?.claims.version) };
  }

  public async selectPersona(
    input: SelectPersonaRequest,
    csrfToken: string | undefined,
    request: Request,
    response: Response
  ): Promise<Readonly<{ session: Extract<AuthSessionResponse, { authenticated: true }>; csrfToken: string }>> {
    const current = await this.resolveSession(request);
    this.assertCsrf(csrfToken, request, current?.claims.version);
    const persona = await this.personas.findById(input.userId);
    if (persona === undefined) this.forbidden();

    const sessionToken = this.sessionCodec.sign({ userId: persona.userId });
    const claims = this.sessionCodec.verify(sessionToken);
    if (claims === undefined) throw new Error('Newly created session could not be verified');
    const seed = this.csrf.createSeed();
    this.writeCookie(response, this.sessionCookieName, sessionToken);
    this.writeCookie(response, this.csrfCookieName, seed);
    return {
      session: {
        authenticated: true,
        persona: { userId: persona.userId, displayName: persona.displayName, role: persona.role },
        version: claims.version
      },
      csrfToken: this.csrf.issue(seed, claims.version)
    };
  }

  public async logout(
    csrfToken: string | undefined,
    request: Request,
    response: Response
  ): Promise<Readonly<{ session: { authenticated: false }; csrfToken: string }>> {
    const current = await this.resolveSession(request);
    this.assertCsrf(csrfToken, request, current?.claims.version);
    const seed = this.csrf.createSeed();
    response.clearCookie(this.sessionCookieName, this.baseCookieOptions);
    this.writeCookie(response, this.csrfCookieName, seed);
    return { session: { authenticated: false }, csrfToken: this.csrf.issue(seed, undefined) };
  }

  public async requireSession(request: Request): Promise<NonNullable<Awaited<ReturnType<AuthService['resolveSession']>>>> {
    const session = await this.resolveSession(request);
    if (session === undefined) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Authentication is required' });
    return session;
  }

  private async resolveSession(request: Request) {
    const claims = this.sessionCodec.verify(this.readCookie(request, this.sessionCookieName));
    if (claims === undefined) return undefined;
    const persona = await this.personas.findById(claims.userId);
    return persona === undefined ? undefined : { claims, persona };
  }

  private assertCsrf(token: string | undefined, request: Request, version: string | undefined): void {
    if (!this.csrf.verify(token, this.readCookie(request, this.csrfCookieName), version)) {
      throw new ForbiddenException({ code: 'INVALID_CSRF', message: 'Request could not be authorized' });
    }
  }

  private forbidden(): never {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Request could not be authorized' });
  }

  private get sessionCookieName(): string {
    return this.options.environment === 'production' ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
  }

  private get csrfCookieName(): string {
    return this.options.environment === 'production' ? CSRF_COOKIE_PROD : CSRF_COOKIE_DEV;
  }

  private get baseCookieOptions(): Omit<CookieOptions, 'maxAge'> {
    return { httpOnly: true, sameSite: 'lax', secure: this.options.environment === 'production', path: '/' };
  }

  private writeCookie(response: Response, name: string, value: string): void {
    response.cookie(name, value, { ...this.baseCookieOptions, maxAge: EIGHT_HOURS_MS });
  }

  private readCookie(request: Request, name: string): string | undefined {
    const header = request.headers.cookie;
    if (!header) return undefined;
    for (const segment of header.split(';')) {
      const separator = segment.indexOf('=');
      if (separator < 0) continue;
      const key = segment.slice(0, separator).trim();
      if (key !== name) continue;
      try { return decodeURIComponent(segment.slice(separator + 1)); } catch { return undefined; }
    }
    return undefined;
  }
}
