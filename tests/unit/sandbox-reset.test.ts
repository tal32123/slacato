import { AuthorizationDeniedError, ResetSandbox, type SandboxResetReport } from '@slacato/core';
import { parseEnv } from '@slacato/infrastructure/config/env';
import {
  assertResettableDatabase,
  resolveSandboxResetPolicy
} from '@slacato/infrastructure/config/sandbox';
import { describe, expect, it } from 'vitest';

const baseEnvironment = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'a-session-secret-that-is-at-least-32-characters'
};

/** Builds a validated environment pointed at a database, with optional sandbox opt-ins. */
function environmentFor(
  databaseUrl: string,
  overrides: Readonly<Record<string, string>> = {}
): ReturnType<typeof parseEnv> {
  return parseEnv({ ...baseEnvironment, DATABASE_URL: databaseUrl, ...overrides });
}

const localDemo = 'postgres://slacato:slacato@127.0.0.1:54329/slacato_demo';
const hosted = 'postgres://app:secret@db.internal.example.com:5432/railway';

describe('sandbox reset environment gate', () => {
  it('is off in a deployment that said nothing about sandboxes', () => {
    expect(resolveSandboxResetPolicy(environmentFor(localDemo))).toMatchObject({ enabled: false });
    expect(resolveSandboxResetPolicy(environmentFor(hosted))).toMatchObject({ enabled: false });
  });

  it('never treats a build mode as permission to erase a database', () => {
    // NODE_ENV describes how the build was compiled. It says nothing about which database this
    // process is connected to, so it must not be able to enable a destructive capability.
    for (const nodeEnvironment of ['development', 'test', 'production']) {
      expect(
        resolveSandboxResetPolicy(environmentFor(localDemo, { NODE_ENV: nodeEnvironment }))
      ).toMatchObject({ enabled: false });
    }
  });

  it('accepts only the exact opt-in literal, so a near miss leaves the reset off', () => {
    for (const attempt of ['1', 'true', 'yes', 'Enabled', 'enabled ', '']) {
      expect(
        resolveSandboxResetPolicy(environmentFor(localDemo, { SLACATO_SANDBOX_RESET: attempt }))
      ).toMatchObject({ enabled: false });
    }
    expect(
      resolveSandboxResetPolicy(environmentFor(localDemo, { SLACATO_SANDBOX_RESET: 'enabled' }))
    ).toEqual({ enabled: true, database: 'slacato_demo' });
  });

  it('refuses a database that is not a designated sandbox even when the reset is enabled', () => {
    expect(
      resolveSandboxResetPolicy(environmentFor(hosted, { SLACATO_SANDBOX_RESET: 'enabled' }))
    ).toMatchObject({ enabled: false });
    // A recognized demo name is not enough on its own: the same name on a remote host is refused.
    expect(
      resolveSandboxResetPolicy(
        environmentFor('postgres://app:secret@db.example.com:5432/slacato_demo', {
          SLACATO_SANDBOX_RESET: 'enabled'
        })
      )
    ).toMatchObject({ enabled: false });
  });

  it('reaches a hosted sandbox only when that exact database is named as well', () => {
    expect(
      resolveSandboxResetPolicy(
        environmentFor(hosted, {
          SLACATO_SANDBOX_RESET: 'enabled',
          SLACATO_SANDBOX_RESET_DATABASE: 'a-different-database'
        })
      )
    ).toMatchObject({ enabled: false });
    expect(
      resolveSandboxResetPolicy(
        environmentFor(hosted, {
          SLACATO_SANDBOX_RESET: 'enabled',
          SLACATO_SANDBOX_RESET_DATABASE: 'railway'
        })
      )
    ).toEqual({ enabled: true, database: 'railway' });
    // Designating a database and then repointing the process disables the reset rather than
    // silently redirecting it at whatever DATABASE_URL now names.
    expect(
      resolveSandboxResetPolicy(
        environmentFor('postgres://app:secret@db.internal.example.com:5432/production', {
          SLACATO_SANDBOX_RESET: 'enabled',
          SLACATO_SANDBOX_RESET_DATABASE: 'railway'
        })
      )
    ).toMatchObject({ enabled: false });
  });
});

describe('demo reset CLI database guard', () => {
  it('refuses a database it does not recognize as a local demo', () => {
    expect(() =>
      assertResettableDatabase('postgres://user:pw@db.example.com:5432/slacato_demo')
    ).toThrow(/Refusing to reset/);
    expect(() => assertResettableDatabase('postgres://user:pw@127.0.0.1:5432/production')).toThrow(
      /Refusing to reset/
    );
  });

  it('accepts a local demo database without ceremony', () => {
    expect(assertResettableDatabase('postgres://user:pw@127.0.0.1:54329/slacato_demo')).toBe(
      'slacato_demo'
    );
  });

  it('requires both the flag and the named database before overriding', () => {
    const url = 'postgres://user:pw@db.example.com:5432/anything';
    expect(() => assertResettableDatabase(url, ['--force-unsafe-database'], {})).toThrow(
      /Refusing to reset/
    );
    expect(() =>
      assertResettableDatabase(url, [], { SLACATO_RESET_CONFIRM_DATABASE: 'anything' })
    ).toThrow(/Refusing to reset/);
    expect(() =>
      assertResettableDatabase(url, ['--force-unsafe-database'], {
        SLACATO_RESET_CONFIRM_DATABASE: 'a-different-database'
      })
    ).toThrow(/Refusing to reset/);
    expect(
      assertResettableDatabase(url, ['--force-unsafe-database'], {
        SLACATO_RESET_CONFIRM_DATABASE: 'anything'
      })
    ).toBe('anything');
  });
});

const report: SandboxResetReport = {
  database: 'slacato_demo',
  tally: {
    runs: 2,
    runsInFlight: 1,
    approvalSubjects: 1,
    approvalDecisions: 0,
    briefs: 1,
    runEvents: 9,
    traceSpans: 20,
    queuedCommands: 0,
    auditEvents: 3
  },
  retained: { evidenceVersions: 137, opportunities: 3, personas: 8 }
};

/** Records what the command asked of the store and what it refused. */
function stubbedSandbox(entitled: boolean) {
  const calls: string[] = [];
  const denials: string[] = [];
  const command = new ResetSandbox(
    {
      mayReset: async (actorId) => {
        calls.push(`mayReset:${actorId}`);
        return entitled;
      },
      preview: async () => {
        calls.push('preview');
        return report;
      },
      erase: async ({ actorId }) => {
        calls.push(`erase:${actorId}`);
        return report;
      }
    },
    {
      recordOpaqueDenial: async (event) => {
        denials.push(`${event.actorId}:${event.reason}`);
      }
    }
  );
  return { command, calls, denials };
}

describe('ResetSandbox authorization', () => {
  it('erases only for an entitled actor', async () => {
    const { command, calls, denials } = stubbedSandbox(true);
    await expect(command.execute({ actorId: 'USR-5001' })).resolves.toEqual(report);
    expect(calls).toEqual(['mayReset:USR-5001', 'erase:USR-5001']);
    expect(denials).toEqual([]);
  });

  it('refuses an actor without standing and never reaches the store', async () => {
    const { command, calls, denials } = stubbedSandbox(false);
    await expect(command.execute({ actorId: 'USR-5007' })).rejects.toBeInstanceOf(
      AuthorizationDeniedError
    );
    expect(calls).toEqual(['mayReset:USR-5007']);
    expect(denials).toEqual(['USR-5007:forbidden']);
  });

  it('guards the preview as strictly as the reset it previews', async () => {
    // The counts describe how much work the shared sandbox is holding. An authorization rule that
    // only covered the destructive call would leave that readable, and would teach callers that
    // the safe-looking route is the unguarded one.
    const { command, calls, denials } = stubbedSandbox(false);
    await expect(command.preview({ actorId: 'USR-5007' })).rejects.toBeInstanceOf(
      AuthorizationDeniedError
    );
    expect(calls).toEqual(['mayReset:USR-5007']);
    expect(denials).toEqual(['USR-5007:forbidden']);
  });
});
