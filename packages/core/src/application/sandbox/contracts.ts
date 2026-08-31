/** Counts the run-scoped records a sandbox reset removes. */
export type SandboxResetTally = Readonly<{
  /** Every run row, in any status, that the sandbox holds. */
  runs: number;
  /**
   * The subset with a workflow step still to execute when the reset was measured.
   *
   * `awaiting_approval` is excluded deliberately. It is a resting state - the run is waiting on a
   * person, not on the worker - so counting it here would warn about interrupting work that is not
   * happening, which is the state most of a finished demo pass is parked in.
   */
  runsInFlight: number;
  approvalSubjects: number;
  approvalDecisions: number;
  briefs: number;
  runEvents: number;
  traceSpans: number;
  /** Outbox commands still waiting to be published to the worker queue. */
  queuedCommands: number;
  /** Audit rows bound to a run. Denial and reset records carry no run and are never removed. */
  auditEvents: number;
}>;

/** Counts the ingested fixture corpus a sandbox reset leaves exactly as it was. */
export type SandboxRetainedFixtures = Readonly<{
  evidenceVersions: number;
  opportunities: number;
  personas: number;
}>;

/** Describes what a sandbox reset would remove, or did remove, and what it kept. */
export type SandboxResetReport = Readonly<{
  database: string;
  tally: SandboxResetTally;
  retained: SandboxRetainedFixtures;
}>;

/**
 * Erases everything the demo produced by being run, and nothing that was ingested into it.
 *
 * The split is the whole contract. Runs, approvals, briefs, events, traces, queued commands and
 * run-bound audit rows are products of a demo pass and are removed. Personas, grants, accounts,
 * opportunities, contacts, documents and evidence versions - including their embeddings - are
 * ingested inputs and are not: deleting them would require a paid re-ingest and re-embed, and
 * would leave the readiness probe's embedding-profile check failing until it happened.
 */
export interface SandboxResetStore {
  /**
   * Reports whether an actor is entitled to erase the shared sandbox.
   *
   * The sandbox is shared, so this answers a question about standing, not about one record.
   */
  mayReset(actorId: string): Promise<boolean>;
  /** Counts what a reset would remove right now, changing nothing. */
  preview(): Promise<SandboxResetReport>;
  /** Removes every run-scoped record in one transaction and records the reset in the audit trail. */
  erase(input: Readonly<{ actorId: string }>): Promise<SandboxResetReport>;
}
