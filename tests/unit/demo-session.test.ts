import { describe, expect, it } from 'vitest';
import { BrowserRequestPolicy, DemoSessionCodec, SessionCsrf } from '@slacato/api/modules/auth/session';

const secret = 'a'.repeat(32);
const issuedAt = Date.parse('2026-08-28T08:00:00.000Z');
const version = '018f69a4-81d4-7a95-96ec-4d0bb24513ca';

describe('DemoSessionCodec', () => {
  it('round-trips an eight-hour signed session without exposing the secret', () => {
    const codec = new DemoSessionCodec(secret, () => issuedAt);
    const token = codec.sign({ userId: 'USR-5001', version });

    expect(codec.verify(token)).toEqual({ userId: 'USR-5001', issuedAt, version });
    expect(token).not.toContain(secret);
  });

  it('rejects a tampered signature and an expired session', () => {
    const codec = new DemoSessionCodec(secret, () => issuedAt);
    const token = codec.sign({ userId: 'USR-5001', version });
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;

    expect(codec.verify(tampered)).toBeUndefined();
    expect(new DemoSessionCodec(secret, () => issuedAt + 8 * 60 * 60 * 1_000 + 1).verify(token)).toBeUndefined();
  });
});

describe('SessionCsrf', () => {
  it('binds a token to both the seed and current session version', () => {
    const csrf = new SessionCsrf(secret);
    const token = csrf.issue('seed-1', 'version-1');

    expect(csrf.verify(token, 'seed-1', 'version-1')).toBe(true);
    expect(csrf.verify(token, 'seed-2', 'version-1')).toBe(false);
    expect(csrf.verify(token, 'seed-1', 'version-2')).toBe(false);
  });
});

describe('BrowserRequestPolicy', () => {
  const policy = new BrowserRequestPolicy(['http://127.0.0.1:4173']);

  it('allows exact same-origin browser mutations', () => {
    expect(policy.evaluate({
      method: 'POST',
      origin: 'http://127.0.0.1:4173',
      secFetchSite: 'same-origin'
    })).toEqual({ allowed: true, origin: 'http://127.0.0.1:4173' });
  });

  it.each([
    { method: 'POST', origin: undefined, secFetchSite: 'same-origin' },
    { method: 'POST', origin: 'https://hostile.example', secFetchSite: 'cross-site' },
    { method: 'POST', origin: 'http://127.0.0.1:4173.evil.example', secFetchSite: 'same-site' },
    { method: 'POST', origin: 'http://127.0.0.1:4173', secFetchSite: undefined }
  ] as const)('rejects missing or hostile mutation provenance: $origin / $secFetchSite', (request) => {
    expect(policy.evaluate(request)).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('allows a same-origin browser read without requiring an Origin header', () => {
    expect(policy.evaluate({ method: 'GET', origin: undefined, secFetchSite: 'same-origin' }))
      .toEqual({ allowed: true });
  });

  it('requires an exact Origin for browser preflight', () => {
    expect(policy.evaluate({ method: 'OPTIONS', origin: undefined, secFetchSite: 'same-origin' }))
      .toEqual({ allowed: false, reason: 'forbidden' });
  });
});
