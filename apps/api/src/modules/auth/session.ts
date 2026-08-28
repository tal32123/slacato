import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const DEMO_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const signedSessionSchema = z.object({
  userId: z.string().regex(/^USR-\d+$/),
  issuedAt: z.number().int().nonnegative(),
  version: z.string().uuid()
}).strict();

export type SignedDemoSession = z.infer<typeof signedSessionSchema>;
export type BrowserRequestMetadata = Readonly<{
  method: string;
  origin: string | undefined;
  secFetchSite: string | undefined;
}>;

function hmac(secret: string, value: string): Buffer {
  return createHmac('sha256', secret).update(value).digest();
}

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  const normalizedLeft = Buffer.alloc(32);
  const normalizedRight = Buffer.alloc(32);
  left.copy(normalizedLeft, 0, 0, Math.min(left.length, normalizedLeft.length));
  right.copy(normalizedRight, 0, 0, Math.min(right.length, normalizedRight.length));
  return timingSafeEqual(normalizedLeft, normalizedRight) && left.length === right.length;
}

/** Encodes short-lived, self-contained demo sessions with a constant-time MAC check. */
export class DemoSessionCodec {
  public constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now
  ) {}

  public sign(input: Readonly<{ userId: string; version?: string }>): string {
    const payload = signedSessionSchema.parse({
      userId: input.userId,
      issuedAt: this.now(),
      version: input.version ?? randomUUID()
    });
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encodedPayload}.${hmac(this.secret, encodedPayload).toString('base64url')}`;
  }

  public verify(token: string | undefined): SignedDemoSession | undefined {
    if (!token) return undefined;
    const parts = token.split('.');
    if (parts.length !== 2) return undefined;
    const [encodedPayload, encodedSignature] = parts;
    if (!encodedPayload || !encodedSignature) return undefined;
    let signature: Buffer;
    try {
      signature = Buffer.from(encodedSignature, 'base64url');
    } catch {
      return undefined;
    }
    if (!constantTimeEqual(signature, hmac(this.secret, encodedPayload))) return undefined;
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as unknown;
    } catch {
      return undefined;
    }
    const parsed = signedSessionSchema.safeParse(rawPayload);
    if (!parsed.success) return undefined;
    const age = this.now() - parsed.data.issuedAt;
    if (age < 0 || age > DEMO_SESSION_TTL_MS) return undefined;
    return parsed.data;
  }
}

/** Issues a double-submit token bound to an HTTP-only seed and current session generation. */
export class SessionCsrf {
  public constructor(private readonly secret: string) {}

  public createSeed(): string {
    return randomBytes(32).toString('base64url');
  }

  public issue(seed: string, sessionVersion: string | undefined): string {
    return hmac(this.secret, `${seed}.${sessionVersion ?? 'anonymous'}`).toString('base64url');
  }

  public verify(token: string | undefined, seed: string | undefined, sessionVersion: string | undefined): boolean {
    if (!token || !seed) return false;
    let supplied: Buffer;
    try {
      supplied = Buffer.from(token, 'base64url');
    } catch {
      return false;
    }
    return constantTimeEqual(supplied, hmac(this.secret, `${seed}.${sessionVersion ?? 'anonymous'}`));
  }
}

/** Applies an exact-origin and Fetch Metadata allowlist to browser-facing auth traffic. */
export class BrowserRequestPolicy {
  private readonly allowedOrigins: ReadonlySet<string>;

  public constructor(origins: readonly string[]) {
    this.allowedOrigins = new Set(origins);
  }

  public evaluate(request: BrowserRequestMetadata):
    | Readonly<{ allowed: true; origin?: string }>
    | Readonly<{ allowed: false; reason: 'forbidden' }> {
    const method = request.method.toUpperCase();
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const requiresOrigin = mutation || method === 'OPTIONS';
    if (request.secFetchSite !== 'same-origin') return { allowed: false, reason: 'forbidden' };
    if (request.origin !== undefined && !this.allowedOrigins.has(request.origin)) return { allowed: false, reason: 'forbidden' };
    if (requiresOrigin && request.origin === undefined) return { allowed: false, reason: 'forbidden' };
    return request.origin === undefined ? { allowed: true } : { allowed: true, origin: request.origin };
  }
}
