import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureApiApplication } from '../../apps/api/src/main';
import { AuthModule } from '../../apps/api/src/modules/auth/auth.module';

const origin = 'http://127.0.0.1:4173';
const maya = {
  userId: 'USR-5001',
  displayName: 'Maya Levin',
  role: 'Account Owner',
  grants: [{
    accountId: 'ACC-2001', sourceType: 'salesforce' as const, canRead: true,
    canReadRestricted: false, canApprove: true, sensitivePricing: false
  }]
};

describe('auth API browser boundary', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    app = await NestFactory.create<NestExpressApplication>(AuthModule.register({
      sessionSecret: 'a-session-secret-that-is-at-least-32-characters',
      environment: 'test',
      allowedOrigins: [origin],
      personaDirectory: {
        list: async () => [maya],
        findById: async (userId: string) => userId === maya.userId ? maya : undefined
      }
    }), { logger: false, bodyParser: false });
    configureApiApplication(app);
    await app.init();
  });

  afterEach(async () => { await app.close(); });

  it('lists only canonical personas and creates a session after CSRF bootstrap', async () => {
    const agent = request.agent(app.getHttpServer());
    const personas = await agent.get('/api/auth/personas').set('Sec-Fetch-Site', 'same-origin').expect(200);
    expect(personas.body).toEqual({ personas: [{ userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner' }] });

    const bootstrap = await agent.get('/api/auth/csrf').set('Sec-Fetch-Site', 'same-origin').expect(200);
    const initialCsrf = bootstrap.body.csrfToken as string;
    expect(bootstrap.headers['set-cookie']?.join(';')).toContain('slacato_csrf_seed=');
    expect(bootstrap.headers['set-cookie']?.join(';')).toContain('HttpOnly');

    const selected = await agent.post('/api/auth/persona')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').set('X-CSRF-Token', initialCsrf)
      .send({ userId: 'USR-5001' }).expect(201);
    expect(selected.body.session).toMatchObject({ authenticated: true, persona: { userId: 'USR-5001' } });
    expect(selected.body.csrfToken).not.toBe(initialCsrf);
    expect(selected.headers['set-cookie']?.join(';')).toContain('slacato_session=');
    expect(selected.headers['set-cookie']?.join(';')).toContain('SameSite=Lax');
    expect(selected.headers['access-control-allow-origin']).toBe(origin);
    expect(selected.headers.vary).toContain('Origin');

    const session = await agent.get('/api/auth/session').set('Sec-Fetch-Site', 'same-origin').expect(200);
    expect(session.body).toMatchObject({ authenticated: true, persona: { displayName: 'Maya Levin' } });
  });

  it('rejects missing CSRF, hostile origins, and arbitrary personas opaquely', async () => {
    const agent = request.agent(app.getHttpServer());
    const bootstrap = await agent.get('/api/auth/csrf').set('Sec-Fetch-Site', 'same-origin').expect(200);

    await agent.post('/api/auth/persona')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
      .send({ userId: 'USR-5001' }).expect(403, { code: 'INVALID_CSRF', message: 'Request could not be authorized' });

    await agent.post('/api/auth/persona')
      .set('Origin', 'https://hostile.example').set('Sec-Fetch-Site', 'cross-site')
      .set('X-CSRF-Token', bootstrap.body.csrfToken as string)
      .send({ userId: 'USR-5001' }).expect(403, { code: 'FORBIDDEN', message: 'Request could not be authorized' });

    await agent.post('/api/auth/persona')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
      .set('X-CSRF-Token', bootstrap.body.csrfToken as string)
      .send({ userId: 'USR-9999' }).expect(403, { code: 'FORBIDDEN', message: 'Request could not be authorized' });
  });

  it('rotates CSRF on logout and clears the session', async () => {
    const agent = request.agent(app.getHttpServer());
    const bootstrap = await agent.get('/api/auth/csrf').set('Sec-Fetch-Site', 'same-origin').expect(200);
    const selected = await agent.post('/api/auth/persona')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').set('X-CSRF-Token', bootstrap.body.csrfToken as string)
      .send({ userId: 'USR-5001' }).expect(201);

    const loggedOut = await agent.post('/api/auth/logout')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').set('X-CSRF-Token', selected.body.csrfToken as string)
      .send({}).expect(201);
    expect(loggedOut.body).toEqual({ session: { authenticated: false }, csrfToken: expect.any(String) });
    expect(loggedOut.body.csrfToken).not.toBe(selected.body.csrfToken);
    expect(loggedOut.headers['set-cookie']?.join(';')).toContain('slacato_session=;');

    await agent.get('/api/auth/session').set('Sec-Fetch-Site', 'same-origin').expect(200, { authenticated: false });
  });

  it('answers exact allowed-origin preflight and rejects hostile preflight', async () => {
    const allowed = await request(app.getHttpServer()).options('/api/auth/persona')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token')
      .expect(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(origin);
    expect(allowed.headers.vary).toContain('Origin');

    await request(app.getHttpServer()).options('/api/auth/persona')
      .set('Origin', 'https://hostile.example').set('Sec-Fetch-Site', 'cross-site')
      .set('Access-Control-Request-Method', 'POST').expect(403);
  });
});

describe('production demo cookies', () => {
  it('uses host-only Secure session and CSRF cookies without a Domain attribute', async () => {
    const app = await NestFactory.create<NestExpressApplication>(AuthModule.register({
      sessionSecret: 'a-session-secret-that-is-at-least-32-characters',
      environment: 'production', allowedOrigins: [origin],
      personaDirectory: { list: async () => [maya], findById: async (userId: string) => userId === maya.userId ? maya : undefined }
    }), { logger: false, bodyParser: false });
    configureApiApplication(app);
    await app.init();
    try {
      const bootstrap = await request(app.getHttpServer()).get('/api/auth/csrf').set('Sec-Fetch-Site', 'same-origin').expect(200);
      const seedCookie = bootstrap.headers['set-cookie']?.find((value: string) => value.startsWith('__Host-slacato_csrf_seed='));
      expect(seedCookie).toContain('Secure');
      expect(seedCookie).toContain('HttpOnly');
      expect(seedCookie).toContain('Path=/');
      expect(seedCookie).not.toContain('Domain=');

      const selected = await request(app.getHttpServer()).post('/api/auth/persona')
        .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
        .set('Cookie', seedCookie!.split(';')[0]!)
        .set('X-CSRF-Token', bootstrap.body.csrfToken as string)
        .send({ userId: 'USR-5001' }).expect(201);
      const sessionCookie = selected.headers['set-cookie']?.find((value: string) => value.startsWith('__Host-slacato_session='));
      expect(sessionCookie).toContain('Max-Age=28800');
      expect(sessionCookie).toContain('Secure');
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Lax');
      expect(sessionCookie).not.toContain('Domain=');
    } finally {
      await app.close();
    }
  });
});
