import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runSnapshotSchema, runStatusSchema as wireRunStatusSchema } from '@slacato/contracts';
import { runStatusSchema as domainRunStatusSchema } from '@slacato/core';

/**
 * The 11-member run-status enum is hand-copied across contracts, the domain
 * layer, and the database schema, with nothing mechanically tying them
 * together. This test detects drift across those seams so that adding or
 * renaming a status fails a test instead of failing at the wire as a 500
 * INVALID_RESPONSE.
 */

const asSet = (values: readonly string[]): Set<string> => new Set(values);

/** Members in `a` but not `b`, formatted for a failure message. */
const describeDrift = (a: Set<string>, b: Set<string>): string[] =>
  [...a].filter((value) => !b.has(value));

const schemaTsPath = fileURLToPath(
  new URL('../../packages/infrastructure/src/db/schema.ts', import.meta.url)
);
const reconcilerTsPath = fileURLToPath(
  new URL('../../packages/infrastructure/src/queue/reconciler.ts', import.meta.url)
);

/** Extracts the single-quoted string literals inside a matched capture group. */
const extractQuotedLiterals = (listBody: string): string[] =>
  [...listBody.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);

/**
 * Pulls the full 11-member status list out of the `runs_status_check` SQL
 * CHECK constraint literal in schema.ts. A regex over the source text is the
 * honest approach here: importing Drizzle internals to introspect a raw sql`
 * tagged template would not be meaningfully more robust, and the constraint
 * name anchors the match so it can't accidentally grab the neighboring
 * `runs_one_active_opportunity_uq` list instead.
 */
const readSchemaCheckConstraintStatuses = (): string[] => {
  const source = readFileSync(schemaTsPath, 'utf8');
  const match = source.match(/runs_status_check['"]?,\s*sql`\$\{table\.status\} in \(([^)]+)\)/);
  if (match === null) {
    throw new Error(
      'run-status-parity.test.ts could not locate the runs_status_check CHECK constraint ' +
        `in ${schemaTsPath}. If that constraint was renamed or reshaped, update the regex ` +
        'in this test alongside it.'
    );
  }
  return extractQuotedLiterals(match[1]);
};

/**
 * Pulls the 7-member non-terminal subset out of the `runs_one_active_opportunity_uq`
 * partial-unique-index predicate in schema.ts.
 */
const readSchemaNonTerminalStatuses = (): string[] => {
  const source = readFileSync(schemaTsPath, 'utf8');
  const match = source.match(
    /runs_one_active_opportunity_uq['"]?\)[\s\S]*?\$\{table\.status\} in \(([^)]+)\)/
  );
  if (match === null) {
    throw new Error(
      'run-status-parity.test.ts could not locate the runs_one_active_opportunity_uq ' +
        `partial index predicate in ${schemaTsPath}. If it was renamed or reshaped, update ` +
        'the regex in this test alongside it.'
    );
  }
  return extractQuotedLiterals(match[1]);
};

/**
 * Pulls the 7-member non-terminal subset out of the dead-letter acknowledgement
 * query in reconciler.ts (the `update runs set status = 'failed' ... where ... status
 * in (...)` guard).
 */
const readReconcilerNonTerminalStatuses = (): string[] => {
  const source = readFileSync(reconcilerTsPath, 'utf8');
  const match = source.match(
    /update runs set status = 'failed'[\s\S]*?and status in \(([^)]+)\)/
  );
  if (match === null) {
    throw new Error(
      'run-status-parity.test.ts could not locate the non-terminal status guard on the ' +
        `dead-letter acknowledgement query in ${reconcilerTsPath}. If that query was ` +
        'reshaped, update the regex in this test alongside it.'
    );
  }
  return extractQuotedLiterals(match[1]);
};

describe('run-status parity across unlinked layers', () => {
  it('wire runStatusSchema matches the domain run-status enum (packages/core/src/domain/runs/contracts.ts)', () => {
    const wireStatuses = asSet(wireRunStatusSchema.options);
    const domainStatuses = asSet(domainRunStatusSchema.options);

    const missingFromDomain = describeDrift(wireStatuses, domainStatuses);
    const missingFromWire = describeDrift(domainStatuses, wireStatuses);

    expect(
      missingFromDomain,
      `Status(es) ${JSON.stringify(missingFromDomain)} exist in packages/contracts/src/runs.ts ` +
        "(runStatusSchema) but not in packages/core/src/domain/runs/contracts.ts's " +
        'runStatusSchema. Update the domain enum to match.'
    ).toEqual([]);
    expect(
      missingFromWire,
      `Status(es) ${JSON.stringify(missingFromWire)} exist in ` +
        "packages/core/src/domain/runs/contracts.ts's runStatusSchema but not in " +
        'packages/contracts/src/runs.ts (runStatusSchema). Update the wire enum to match.'
    ).toEqual([]);
  });

  it('wire runStatusSchema matches the SQL CHECK constraint literal (packages/infrastructure/src/db/schema.ts:runs_status_check)', () => {
    const wireStatuses = asSet(wireRunStatusSchema.options);
    const sqlStatuses = asSet(readSchemaCheckConstraintStatuses());

    const missingFromSql = describeDrift(wireStatuses, sqlStatuses);
    const missingFromWire = describeDrift(sqlStatuses, wireStatuses);

    expect(
      missingFromSql,
      `Status(es) ${JSON.stringify(missingFromSql)} exist in packages/contracts/src/runs.ts ` +
        "(runStatusSchema) but not in the runs_status_check CHECK constraint in " +
        'packages/infrastructure/src/db/schema.ts. Update the CHECK constraint literal to match ' +
        '(this requires a migration).'
    ).toEqual([]);
    expect(
      missingFromWire,
      `Status(es) ${JSON.stringify(missingFromWire)} exist in the runs_status_check CHECK ` +
        'constraint in packages/infrastructure/src/db/schema.ts but not in ' +
        'packages/contracts/src/runs.ts (runStatusSchema). Update the wire enum to match.'
    ).toEqual([]);
  });

  it('the 7-member non-terminal status subset matches between schema.ts and reconciler.ts', () => {
    const schemaNonTerminal = asSet(readSchemaNonTerminalStatuses());
    const reconcilerNonTerminal = asSet(readReconcilerNonTerminalStatuses());

    const missingFromReconciler = describeDrift(schemaNonTerminal, reconcilerNonTerminal);
    const missingFromSchema = describeDrift(reconcilerNonTerminal, schemaNonTerminal);

    expect(
      missingFromReconciler,
      `Status(es) ${JSON.stringify(missingFromReconciler)} are in the ` +
        'runs_one_active_opportunity_uq non-terminal subset in ' +
        'packages/infrastructure/src/db/schema.ts but not in the dead-letter acknowledgement ' +
        'guard in packages/infrastructure/src/queue/reconciler.ts. Update reconciler.ts to match.'
    ).toEqual([]);
    expect(
      missingFromSchema,
      `Status(es) ${JSON.stringify(missingFromSchema)} are in the dead-letter acknowledgement ` +
        'guard in packages/infrastructure/src/queue/reconciler.ts but not in the ' +
        'runs_one_active_opportunity_uq non-terminal subset in ' +
        'packages/infrastructure/src/db/schema.ts. Update schema.ts to match (this requires a ' +
        'migration).'
    ).toEqual([]);

    // Sanity check: this subset is documented as exactly the 7 non-terminal statuses.
    expect(
      schemaNonTerminal.size,
      'Expected exactly 7 non-terminal statuses in schema.ts\'s ' +
        'runs_one_active_opportunity_uq predicate; the extraction regex may be matching the ' +
        'wrong SQL literal.'
    ).toBe(7);

    // The two files could stay in sync with each other while both drifting from
    // the canonical wire enum (e.g. a status renamed everywhere except here) --
    // which is exactly the "compiles clean, fails at the wire" failure mode this
    // whole test file exists to catch. Check the subset against the wire enum too.
    const wireStatuses = asSet(wireRunStatusSchema.options);
    const notInWireEnum = describeDrift(schemaNonTerminal, wireStatuses);
    expect(
      notInWireEnum,
      `Status(es) ${JSON.stringify(notInWireEnum)} appear in the non-terminal subset ` +
        '(packages/infrastructure/src/db/schema.ts and/or ' +
        'packages/infrastructure/src/queue/reconciler.ts) but do not exist in the canonical ' +
        'wire enum (packages/contracts/src/runs.ts). One of them was likely renamed.'
    ).toEqual([]);
  });

  it("events.ts's event-payload status schema still accepts the canonical set plus the known 'running' extra", () => {
    // packages/contracts/src/events.ts's runStatusSchema is module-private, but it
    // is reachable behaviorally through the exported runSnapshotSchema, which uses
    // it for `status`. This proves the `z.enum([...canonicalRunStatusSchema.options,
    // 'running'])` construction in events.ts actually reconstructed every canonical
    // member (not just some), preserved the one documented extra ('running'), and
    // did not degrade into something more permissive than that exact set.
    const snapshotWith = (status: string) => ({
      streamId: 'run_1',
      status,
      version: 0,
      watermark: null,
      terminal: false
    });

    for (const status of wireRunStatusSchema.options) {
      expect(
        runSnapshotSchema.safeParse(snapshotWith(status)).success,
        `packages/contracts/src/events.ts's event-payload status schema no longer accepts ` +
          `canonical status '${status}'. Update its runStatusSchema construction to match ` +
          'packages/contracts/src/runs.ts.'
      ).toBe(true);
    }

    expect(
      runSnapshotSchema.safeParse(snapshotWith('running')).success,
      "packages/contracts/src/events.ts's event-payload status schema dropped the documented " +
        "'running' extra -- the dedup narrowed wire behavior. Either restore it or, if this is " +
        'a deliberate behavior change, update this test and the comment in events.ts.'
    ).toBe(true);

    expect(
      runSnapshotSchema.safeParse(snapshotWith('bogus_status')).success,
      "packages/contracts/src/events.ts's event-payload status schema accepted an unknown " +
        'status -- it may have degraded to an unbounded string instead of an enum.'
    ).toBe(false);
  });
});
