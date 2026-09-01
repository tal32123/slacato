import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ResetSandbox, type SandboxResetReport, type SandboxResetStore } from '@slacato/core';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module';
import { configureApiApplication } from '../../apps/api/src/main';

const origin = 'http://127.0.0.1:4173';

const report: SandboxResetReport = {
  database: 'slacato_demo',
  tally: {
    runs: 3,
    runsInFlight: 1,
    approvalSubjects: 2,
    approvalDecisions: 5,
    briefs: 2,
    runEvents: 41,
    traceSpans: 12,
    queuedCommands: 0,
    auditEvents: 7
  },
  retained: { evidenceVersions: 137, opportunities: 3, personas: 8 }
};

/** Builds the two demo identities these tests need: one entitled to reset, one not. */
const personas = [
  {
    userId: 'USR-5001',
    displayName: 'Maya Levin',
    role: 'Account Owner',
    grants: [
      {
        accountId: 'ACC-2001',
        sourceType: 'salesforce' as const,
        canRead: true,
        canReadRestricted: false,
        canRequestApproval: true,
        canApprove: false,
        sensitivePricing: false
      }
    ]
  },
  {
    userId: 'USR-5007',
    displayName: 'Harper Noor',
    role: 'Unauthorized Requester',
    grants: []
  }
];

/** Records every erase the store was actually asked to perform. */
function recordingStore(entitled: ReadonlySet<string>): SandboxResetStore & { erased: string[] } {
  const erased: string[] = [];
  return {
    erased,
    mayReset: async (actorId) => entitled.has(actorId),
    preview: async () => report,
    erase: async ({ actorId }) => {
      erased.push(actorId);
      return report;
    }
  };
}

/** Composes the real API around a sandbox capability that is present, or deliberately absent. */
async function apiWith(
  store: SandboxResetStore | undefined
): Promise<NestExpressApplication & { close: () => Promise<void> }> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(
      {
        sessionSecret: 'a-session-secret-that-is-at-least-32-characters',
        environment: 'test',
        allowedOrigins: [origin],
        personaDirectory: {
          list: async () => personas,
          findById: async (userId: string) => personas.find((one) => one.userId === userId)
        }
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store === undefined
        ? undefined
        : { resetSandbox: new ResetSandbox(store, { recordOpaqueDenial: async () => undefined }) }
    ),
    { logger: false, bodyParser: false }
  );
  configureApiApplication(app);
  await app.init();
  return app;
}

/** Signs in as a persona and returns the agent plus the CSRF token bound to that session. */
async function signIn(app: NestExpressApplication, userId: string) {
  const agent = request.agent(app.getHttpServer());
  const bootstrap = await agent
    .get('/api/auth/csrf')
    .set('Origin', origin)
    .set('Sec-Fetch-Site', 'same-site')
    .expect(200);
  const selected = await agent
    .post('/api/auth/persona')
    .set('Origin', origin)
    .set('Sec-Fetch-Site', 'same-site')
    .set('X-CSRF-Token', bootstrap.body.csrfToken as string)
    .send({ userId })
    .expect(201);
  return { agent, csrfToken: selected.body.csrfToken as string };
}

describe('sandbox reset endpoint', () => {
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('does not exist at all in a deployment that was never designated a sandbox', async () => {
    app = await apiWith(undefined);
    const { agent, csrfToken } = await signIn(app, 'USR-5001');
    await agent
      .get('/api/sandbox/reset')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-site')
      .expect(404);
    await agent
      .post('/api/sandbox/reset')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-site')
      .set('X-CSRF-Token', csrfToken)
      .send({ confirmation: 'RESET SANDBOX' })
      .expect(404);
  });

  it('requires a signed session before it will even describe the sandbox', async () => {
    const store = recordingStore(new Set(['USR-5001']));
    app = await apiWith(store);
    await request(app.getHttpServer())
      .get('/api/sandbox/reset')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-site')
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/sandbox/reset')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-site')
      .send({ confirmation: 'RESET SANDBOX' })
      .expect(401);
    expect(store.erased).toEqual([]);
  });

  it('refuses a reset that arrives without the session CSRF token', async () => {
    const store = recordingStore(new Set(['USR-5001']));
    app = await apiWith(store);
    const { agent } = await signIn(app, 'USR-5001');
    await agent
      .post('/api/sandbox/reset')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-site')
      .send({ confirmation: 'RESET SANDBOX' })
      .expect(403, { code: 'INVALID_CSRF', message: 'Request could not be authorized' });
    expect(store.erased).toEqual([]);
  });

  it('refuses a bare or mistyped POST even from an entitled persona', async () => {
    // The confirmation literal is the last line of defence against a replayed URL, a curl with no
    // payload, or a click that reached the route without ever seeing the counts.
    const store = recordingStore(new Set(['USR-5001']));
    app = await apiWith(store);
    const { agent, csrfToken } = await signIn(app, 'USR-5001');
    for (const body of [{}, { confirmation: 'reset sandbox' }, { confirmation: '' }]) {
      await agent
        .post('/api/sandbox/reset')
        .set('Origin', origin)
        .set('Sec-Fetch-Site', 'same-site')
        .set('X-CSRF-Token', csrfToken)
        .send(body)
        .expect(400);
    }
    expect(store.erased).toEqual([]);
  });

  it('answers a persona without standing exactly as an unconfigured deployment does', async () => {
    // Both are 404. A caller cannot learn from the response whether they lack permission or the
    // capability was never enabled, which is what lets the interface hide the control on either.
    const store = recordingStore(new Set(['USR-5001']));
    app = await apiWith(store);
    const { agent, csrfToken } = await signIn(app, 'USR-5007');
    await agent
      .get('/api/sandbox/reset')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-site')
      .expect(404);
    await agent
      .post('/api/sandbox/reset')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-site')
      .set('X-CSRF-Token', csrfToken)
      .send({ confirmation: 'RESET SANDBOX' })
      .expect(404);
    expect(store.erased).toEqual([]);
  });

  it('previews and resets for an entitled persona over an authorized session', async () => {
    const store = recordingStore(new Set(['USR-5001']));
    app = await apiWith(store);
    const { agent, csrfToken } = await signIn(app, 'USR-5001');
    const preview = await agent
      .get('/api/sandbox/reset')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-site')
      .expect(200);
    expect(preview.body).toEqual(report);
    expect(store.erased).toEqual([]);

    const performed = await agent
      .post('/api/sandbox/reset')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-site')
      .set('X-CSRF-Token', csrfToken)
      .send({ confirmation: 'RESET SANDBOX' })
      .expect(201);
    expect(performed.body).toEqual(report);
    expect(store.erased).toEqual(['USR-5001']);
  });
});
