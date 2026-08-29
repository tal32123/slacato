import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthSessionResponse, Persona, SelectPersonaRequest } from '@slacato/contracts';
import type { Request, Response } from 'express';
import {
  AUTH_OPTIONS,
  type AuthModuleOptions,
  type CanonicalPersonaDirectory,
  PERSONA_DIRECTORY,
  SESSION_REGISTRY,
  type SessionRegistry
} from './contracts.js';
import { DEMO_SESSION_TTL_MS, DemoSessionCodec, SessionCsrf } from './session.js';

const SESSION_COOKIE_DEV = 'slacato_session';
const CSRF_COOKIE_DEV = 'slacato_csrf_seed';
const SESSION_COOKIE_PROD = '__Host-slacato_session';
const CSRF_COOKIE_PROD = '__Host-slacato_csrf_seed';

type CookieOptions = Readonly<{
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}>;

/** Coordinates demo persona selection, session registry state, cookies, and CSRF enforcement. */
@Injectable()
export class AuthService {
  private readonly sessionCodec: DemoSessionCodec;
  private readonly csrf: SessionCsrf;

  /** Initializes session and CSRF codecs from the configured secret. */
  public constructor(
    @Inject(AUTH_OPTIONS) private readonly options: AuthModuleOptions,
    @Inject(PERSONA_DIRECTORY) private readonly personas: CanonicalPersonaDirectory,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry
  ) {
    this.sessionCodec = new DemoSessionCodec(options.sessionSecret);
    this.csrf = new SessionCsrf(options.sessionSecret);
  }

  /** Lists selectable personas without exposing directory-only fields. */
  public async listPersonas(): Promise<Readonly<{ personas: readonly Persona[] }>> {
    const personas = await this.personas.list();
    return {
      personas: personas.map(({ userId, displayName, role }) => ({ userId, displayName, role }))
    };
  }

  /** Resolves the request's active signed session into the public authentication response. */
  public async getSession(request: Request): Promise<AuthSessionResponse> {
    const resolved = await this.resolveSession(request);
    return resolved === undefined
      ? { authenticated: false }
      : {
          authenticated: true,
          persona: {
            userId: resolved.persona.userId,
            displayName: resolved.persona.displayName,
            role: resolved.persona.role
          },
          version: resolved.claims.version
        };
  }

  /** Issues a CSRF token bound to the request's current anonymous or authenticated session. */
  public async bootstrapCsrf(
    request: Request,
    response: Response
  ): Promise<Readonly<{ csrfToken: string }>> {
    const session = await this.resolveSession(request);
    const seed = this.readCookie(request, this.csrfCookieName) ?? this.csrf.createSeed();
    this.writeCookie(response, this.csrfCookieName, seed);
    return { csrfToken: this.csrf.issue(seed, session?.claims.version) };
  }

  /** Revokes any request session, activates the selected persona, and writes the new session cookies. */
  public async selectPersona(
    input: SelectPersonaRequest,
    request: Request,
    response: Response
  ): Promise<
    Readonly<{ session: Extract<AuthSessionResponse, { authenticated: true }>; csrfToken: string }>
  > {
    const persona = await this.personas.findById(input.userId);
    if (persona === undefined) this.forbidden();
    await this.revokeRequestSession(request);

    const sessionToken = this.sessionCodec.sign({ userId: persona.userId });
    const claims = this.sessionCodec.verify(sessionToken);
    if (claims === undefined) throw new Error('Newly created session could not be verified');
    await this.sessions.activate({
      version: claims.version,
      userId: claims.userId,
      expiresAt: new Date(claims.issuedAt + DEMO_SESSION_TTL_MS)
    });
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

  /** Revokes the request session, clears its cookie, and rotates anonymous CSRF state. */
  public async logout(
    request: Request,
    response: Response
  ): Promise<Readonly<{ session: { authenticated: false }; csrfToken: string }>> {
    await this.revokeRequestSession(request);
    const seed = this.csrf.createSeed();
    response.clearCookie(this.sessionCookieName, this.baseCookieOptions);
    this.writeCookie(response, this.csrfCookieName, seed);
    return { session: { authenticated: false }, csrfToken: this.csrf.issue(seed, undefined) };
  }

  /** Returns the active session or throws an unauthorized response. */
  public async requireSession(
    request: Request
  ): Promise<NonNullable<Awaited<ReturnType<AuthService['resolveSession']>>>> {
    const session = await this.resolveSession(request);
    if (session === undefined)
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Authentication is required'
      });
    return session;
  }

  /** Requires a valid CSRF token bound to the request's current session state. */
  public async assertPublicMutationCsrf(
    request: Request,
    token: string | undefined
  ): Promise<void> {
    const session = await this.resolveSession(request);
    this.assertCsrf(token, request, session?.claims.version);
  }

  /** Requires a valid CSRF token bound to the supplied authenticated session generation. */
  public assertAuthenticatedMutationCsrf(
    request: Request,
    token: string | undefined,
    sessionVersion: string
  ): void {
    this.assertCsrf(token, request, sessionVersion);
  }

  /** Checks whether the registry still recognizes a session generation for the user. */
  public async isSessionActive(version: string, userId: string): Promise<boolean> {
    return this.sessions.isActive(version, userId);
  }

  /** Resolves an active signed request session and its canonical persona. */
  private async resolveSession(request: Request) {
    const claims = this.sessionCodec.verify(this.readCookie(request, this.sessionCookieName));
    if (claims === undefined) return undefined;
    if (!(await this.sessions.isActive(claims.version, claims.userId))) return undefined;
    const persona = await this.personas.findById(claims.userId);
    return persona === undefined ? undefined : { claims, persona };
  }
  /** Revokes the signed session presented by the request when present. */
  private async revokeRequestSession(request: Request): Promise<void> {
    const claims = this.sessionCodec.verify(this.readCookie(request, this.sessionCookieName));
    if (claims !== undefined) await this.sessions.revoke(claims.version);
  }

  /** Verifies a CSRF token against the request seed and session generation. */
  private assertCsrf(
    token: string | undefined,
    request: Request,
    version: string | undefined
  ): void {
    if (!this.csrf.verify(token, this.readCookie(request, this.csrfCookieName), version)) {
      throw new ForbiddenException({
        code: 'INVALID_CSRF',
        message: 'Request could not be authorized'
      });
    }
  }

  /** Throws the service's standard forbidden response. */
  private forbidden(): never {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Request could not be authorized' });
  }

  /** Selects the environment-appropriate session cookie name. */
  private get sessionCookieName(): string {
    return this.options.environment === 'production' ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
  }

  /** Selects the environment-appropriate CSRF cookie name. */
  private get csrfCookieName(): string {
    return this.options.environment === 'production' ? CSRF_COOKIE_PROD : CSRF_COOKIE_DEV;
  }

  /** Builds the shared security options for authentication cookies. */
  private get baseCookieOptions(): Omit<CookieOptions, 'maxAge'> {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.options.environment === 'production',
      path: '/'
    };
  }

  /** Writes a secure authentication cookie with the demo session lifetime. */
  private writeCookie(response: Response, name: string, value: string): void {
    response.cookie(name, value, { ...this.baseCookieOptions, maxAge: DEMO_SESSION_TTL_MS });
  }

  /** Reads and decodes a named cookie from the request header. */
  private readCookie(request: Request, name: string): string | undefined {
    const header = request.headers.cookie;
    if (!header) return undefined;
    for (const segment of header.split(';')) {
      const separator = segment.indexOf('=');
      if (separator < 0) continue;
      const key = segment.slice(0, separator).trim();
      if (key !== name) continue;
      try {
        return decodeURIComponent(segment.slice(separator + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
