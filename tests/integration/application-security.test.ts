import { Controller, Get, HttpCode, Module, Options, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { configureApiApplication } from '../../apps/api/src/main';
import { AuthModule } from '../../apps/api/src/modules/auth/auth.module';
import { ZodResponse } from '../../apps/api/src/common/wire/zod.decorators';
import { NonBrowserPublic } from '../../apps/api/src/common/security/access.metadata';

const origin = 'http://127.0.0.1:4173';
const responseSchema = z.object({ userId: z.string() }).strict();

class ProtectedProbeController {
  public read(request: Request & { auth?: { persona: { userId: string } } }) {
    return { userId: request.auth?.persona.userId ?? 'missing' };
  }

  public mutate(request: Request & { auth?: { persona: { userId: string } } }) {
    return { userId: request.auth?.persona.userId ?? 'missing' };
  }

  public machineMutation() { return { userId: 'machine' }; }
  public preflight(): undefined { return undefined; }
}
const machineDescriptor = Object.getOwnPropertyDescriptor(ProtectedProbeController.prototype, 'machineMutation')!;
Post('machine-public')(ProtectedProbeController.prototype, 'machineMutation', machineDescriptor);
NonBrowserPublic()(ProtectedProbeController.prototype, 'machineMutation', machineDescriptor);
ZodResponse(responseSchema)(ProtectedProbeController.prototype, 'machineMutation', machineDescriptor);
const preflightDescriptor = Object.getOwnPropertyDescriptor(ProtectedProbeController.prototype, 'preflight')!;
Options()(ProtectedProbeController.prototype, 'preflight', preflightDescriptor);
HttpCode(204)(ProtectedProbeController.prototype, 'preflight', preflightDescriptor);
ZodResponse(z.undefined())(ProtectedProbeController.prototype, 'preflight', preflightDescriptor);

Controller('api/protected-probe')(ProtectedProbeController);
for (const [method, decorator] of [['read', Get()], ['mutate', Post()]] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(ProtectedProbeController.prototype, method)!;
  decorator(ProtectedProbeController.prototype, method, descriptor);
  ZodResponse(responseSchema)(ProtectedProbeController.prototype, method, descriptor);
  Req()(ProtectedProbeController.prototype, method, 0);
}

describe('application-wide security guard', () => {
  let app: NestExpressApplication;
  let failDirectory = false;

  beforeEach(async () => {
    const persona = {
      userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner',
      grants: [{ accountId: 'ACC-2001', sourceType: 'salesforce' as const, canRead: true,
        canReadRestricted: false, canRequestApproval: true, canApprove: false, sensitivePricing: false }]
    };
    const auth = AuthModule.register({
      sessionSecret: 'a-session-secret-that-is-at-least-32-characters', environment: 'test', allowedOrigins: [origin],
      personaDirectory: {
        list: async () => [persona],
        findById: async (userId: string) => {
          if (failDirectory) throw new Error('database unavailable');
          return userId === persona.userId ? persona : undefined;
        }
      }
    });
    class SecurityTestModule {}
    Module({ imports: [auth], controllers: [ProtectedProbeController] })(SecurityTestModule);
    app = await NestFactory.create<NestExpressApplication>(SecurityTestModule, { logger: false, bodyParser: false });
    configureApiApplication(app);
    await app.init();
  });

  afterEach(async () => { await app.close(); });

  it('protects a future controller by default and centrally enforces mutation CSRF', async () => {
    await request(app.getHttpServer()).get('/api/protected-probe').set('Origin', origin).set('Sec-Fetch-Site', 'same-site')
      .expect(401, { code: 'UNAUTHORIZED', message: 'Authentication is required' });

    const agent = request.agent(app.getHttpServer());
    const bootstrap = await agent.get('/api/auth/csrf').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(200);
    const selected = await agent.post('/api/auth/persona')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-site').set('X-CSRF-Token', bootstrap.body.csrfToken as string)
      .send({ userId: 'USR-5001' }).expect(201);

    await agent.get('/api/protected-probe').set('Origin', origin).set('Sec-Fetch-Site', 'same-site')
      .expect(200, { userId: 'USR-5001' });
    await agent.post('/api/protected-probe').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').send({})
      .expect(403, { code: 'INVALID_CSRF', message: 'Request could not be authorized' });
    await agent.post('/api/protected-probe')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-site').set('X-CSRF-Token', selected.body.csrfToken as string)
      .send({}).expect(201, { userId: 'USR-5001' });
  });

  it('does not disguise a persona-store outage as an authentication failure', async () => {
    const agent = request.agent(app.getHttpServer());
    const bootstrap = await agent.get('/api/auth/csrf').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(200);
    await agent.post('/api/auth/persona')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-site').set('X-CSRF-Token', bootstrap.body.csrfToken as string)
      .send({ userId: 'USR-5001' }).expect(201);
    failDirectory = true;

    await agent.get('/api/protected-probe').set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(500);
  });

  it('never lets a non-browser public annotation open a mutation endpoint', async () => {
    await request(app.getHttpServer()).post('/api/protected-probe/machine-public').send({})
      .expect(403, { code: 'FORBIDDEN', message: 'Request could not be authorized' });
  });

  it('allows an exact-origin preflight for a future protected mutation without a session', async () => {
    await request(app.getHttpServer()).options('/api/protected-probe')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-site')
      .set('Access-Control-Request-Method', 'POST').expect(204);
  });
});
