import { z } from 'zod';

const count = z.number().int().min(0).max(10_000_000);

/**
 * Counts the records a sandbox reset removes, grouped the way a reviewer reads them.
 *
 * The confirmation step names these numbers rather than asking a generic "are you sure", so the
 * operator agrees to a specific amount of destruction instead of to a word.
 */
export const sandboxResetTallySchema = z
  .object({
    runs: count,
    runsInFlight: count,
    approvalSubjects: count,
    approvalDecisions: count,
    briefs: count,
    runEvents: count,
    traceSpans: count,
    queuedCommands: count,
    auditEvents: count
  })
  .strict();

/**
 * Counts the ingested fixture corpus a sandbox reset deliberately leaves untouched.
 *
 * Reported alongside the deletions because the boundary is the surprising part: a reset that also
 * cleared evidence would demand a paid re-ingest and re-embed, and would leave `/api/health/ready`
 * failing its index check until it happened.
 */
export const sandboxRetainedFixturesSchema = z
  .object({ evidenceVersions: count, opportunities: count, personas: count })
  .strict();

export const sandboxResetReportSchema = z
  .object({
    database: z.string().min(1).max(120),
    tally: sandboxResetTallySchema,
    retained: sandboxRetainedFixturesSchema
  })
  .strict();

/** The literal a reset request must carry, so no empty or accidental POST can erase a sandbox. */
export const SANDBOX_RESET_CONFIRMATION = 'RESET SANDBOX';

export const sandboxResetRequestSchema = z
  .object({ confirmation: z.literal(SANDBOX_RESET_CONFIRMATION) })
  .strict();

export type SandboxResetTallyView = z.infer<typeof sandboxResetTallySchema>;
export type SandboxRetainedFixturesView = z.infer<typeof sandboxRetainedFixturesSchema>;
export type SandboxResetReportView = z.infer<typeof sandboxResetReportSchema>;
export type SandboxResetRequest = z.infer<typeof sandboxResetRequestSchema>;
