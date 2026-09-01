import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createDatabaseClient,
  PostgresBriefExportService
} from '../packages/infrastructure/src/index.js';
import { evaluateBriefQuality, expectationsForOpportunity } from './brief-quality.js';

/**
 * Drives the live sample runs whose outputs `scripts/export-sample-artifacts.ts` exports.
 *
 * Two facts the graded approval artifact has to carry cannot be reconstructed after a run
 * finalizes, so they are captured here, while the run is still open:
 *
 *  - a finalized export is refused while the run is `awaiting_approval`, and
 *  - a dependent approval gate only becomes operable once the gates it depends on have cleared,
 *    which the `authorized_run_approval_grants` view recomputes on every read.
 *
 * The script therefore snapshots every approver's inbox between decisions and writes the complete
 * routing artifact itself; the exporter reads the finalized runs and produces everything else.
 */

const DEFAULT_DATABASE_URL = 'postgresql://slacato:slacato@127.0.0.1:54329/slacato_samples';
const DEFAULT_API_BASE = 'http://127.0.0.1:3017';
const BROWSER_ORIGIN = 'http://localhost:5173';
const POLL_INTERVAL_MS = 2_000;
const POLL_ATTEMPTS = 180;

/** The persona authorized to request a brief for each opportunity in the canonical fixtures. */
const REQUESTER_BY_OPPORTUNITY: Readonly<Record<string, string>> = {
  'OPP-1001': 'USR-5001',
  'OPP-1002': 'USR-5002',
  'OPP-1003': 'USR-5003'
};

/** Every persona that holds an approval authority in the canonical fixtures. */
const APPROVER_USER_IDS: readonly string[] = [
  'USR-5005',
  'USR-5006',
  'USR-5008',
  'USR-5004',
  'USR-5003',
  'USR-5001',
  'USR-5002'
];

type RunDetail = Readonly<{ runId: string; status: string; version: number }>;

type InboxEntry = Readonly<{
  approvalSubjectId: string;
  runId: string;
  runVersion: number;
  subjectHash: string;
  entryId: string;
  category: string;
  requiredAuthorities: readonly string[];
  availableAuthority: string;
  quorum: Readonly<{ completed: number; required: number }>;
}>;

/** One live run this script drove, with the outcome the exporter needs to locate it. */
export type SampleRunRecord = Readonly<{
  opportunityId: string;
  requestedBy: string;
  runId: string;
  status: string;
  approvalsApplied: number;
  briefQuality?: Readonly<{
    violations: readonly string[];
    sourceTypes: readonly string[];
    stakeholders: number;
    sections: Readonly<Record<string, number>>;
  }>;
}>;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Waits between run-status polls without busy-looping the API. */
function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/** A cookie-bearing API client that presents the same headers the browser SPA does. */
class BrowserSession {
  private readonly cookies = new Map<string, string>();
  private csrfToken = '';

  /** Binds a session to one API origin. */
  public constructor(private readonly apiBase: string) {}

  /** Issues one API request carrying the session's cookies and browser-equivalent headers. */
  public async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Origin', BROWSER_ORIGIN);
    headers.set('Sec-Fetch-Site', 'same-site');
    if (this.cookies.size > 0) {
      headers.set(
        'Cookie',
        [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
      );
    }
    const response = await fetch(`${this.apiBase}${path}`, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';', 1);
      if (pair === undefined) continue;
      const separator = pair.indexOf('=');
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }

  /** Signs the session in as one demo persona and remembers its CSRF token. */
  public async selectPersona(userId: string): Promise<void> {
    const csrfResponse = await this.request('/api/auth/csrf');
    if (!csrfResponse.ok) throw new Error(`CSRF bootstrap failed: ${csrfResponse.status}`);
    const csrf = (await csrfResponse.json()) as { csrfToken: string };
    const loginResponse = await this.request('/api/auth/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
      body: JSON.stringify({ userId })
    });
    if (!loginResponse.ok) throw new Error(`Persona selection failed: ${loginResponse.status}`);
    this.csrfToken = ((await loginResponse.json()) as { csrfToken: string }).csrfToken;
  }

  /** Issues one state-changing request with the session's CSRF token attached. */
  public async post(path: string, body: unknown): Promise<Response> {
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      body: JSON.stringify(body)
    });
  }

  /** Reads one JSON resource, failing loudly on any non-success status. */
  public async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path);
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
    return (await response.json()) as T;
  }
}

/** Polls one run until it reaches a state the caller can act on, or the deadline expires. */
async function pollUntilSettled(session: BrowserSession, runId: string): Promise<RunDetail> {
  let detail = await session.getJson<RunDetail>(`/api/runs/${runId}/detail`);
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (
      ['completed', 'rejected', 'failed', 'cancelled', 'awaiting_approval'].includes(detail.status)
    )
      return detail;
    await delay(POLL_INTERVAL_MS);
    detail = await session.getJson<RunDetail>(`/api/runs/${runId}/detail`);
  }
  return detail;
}

/** Reports which approval entries each approver can currently operate on for one run. */
async function operableByApprover(
  sessions: ReadonlyMap<string, BrowserSession>,
  runId: string
): Promise<Readonly<Record<string, readonly string[]>>> {
  const snapshot: Record<string, readonly string[]> = {};
  for (const [userId, session] of sessions) {
    const inbox = await session.getJson<{ pending: InboxEntry[] }>('/api/approvals');
    const operable = inbox.pending
      .filter((entry) => entry.runId === runId)
      .map((entry) => `${entry.entryId} (as ${entry.availableAuthority})`);
    if (operable.length > 0) snapshot[userId] = operable;
  }
  return snapshot;
}

/** Chooses the approver to act next, preferring an actor who did not request the run. */
function chooseApprover(
  snapshot: Readonly<Record<string, readonly string[]>>,
  requestedBy: string
): Readonly<{ userId: string; entryId: string }> | undefined {
  const candidates = Object.entries(snapshot).filter(([, entries]) => entries.length > 0);
  const preferred = candidates.find(([userId]) => userId !== requestedBy) ?? candidates[0];
  if (preferred === undefined) return undefined;
  const [userId, entries] = preferred;
  const entryId = entries[0]?.split(' ')[0];
  if (entryId === undefined) return undefined;
  return { userId, entryId };
}

/** Drives one opportunity end to end and, when the run stops for approval, clears its quorum. */
async function driveOpportunity(
  apiBase: string,
  databaseUrl: string,
  opportunityId: string,
  approvalCapturePath: string | undefined
): Promise<SampleRunRecord> {
  const requestedBy = REQUESTER_BY_OPPORTUNITY[opportunityId];
  if (requestedBy === undefined) throw new Error(`No authorized requester for ${opportunityId}`);
  const requester = new BrowserSession(apiBase);
  await requester.selectPersona(requestedBy);
  const started = await requester.post('/api/runs/deal-brief', {
    opportunityId,
    idempotencyKey: `sample-run-${opportunityId}-${Date.now()}`
  });
  if (!started.ok) throw new Error(`Start failed for ${opportunityId}: ${started.status}`);
  const { runId } = (await started.json()) as { runId: string };
  process.stdout.write(`${opportunityId}: started ${runId}\n`);

  let detail = await pollUntilSettled(requester, runId);
  let approvalsApplied = 0;
  if (detail.status === 'awaiting_approval') {
    const sessions = new Map<string, BrowserSession>();
    for (const userId of APPROVER_USER_IDS) {
      const session = new BrowserSession(apiBase);
      await session.selectPersona(userId);
      sessions.set(userId, session);
    }
    const refusal = await requester.request(`/api/runs/${runId}/export/json`);
    const exportBeforeQuorum = {
      attemptedAt: new Date().toISOString(),
      actorId: requestedBy,
      request: `GET /api/runs/${runId}/export/json`,
      httpStatus: refusal.status,
      response: (await refusal.json()) as unknown,
      runStatusAtAttempt: detail.status
    };
    const progression: unknown[] = [];
    for (let step = 1; step <= 12; step += 1) {
      const operableBefore = await operableByApprover(sessions, runId);
      const choice = chooseApprover(operableBefore, requestedBy);
      if (choice === undefined) break;
      const session = sessions.get(choice.userId);
      if (session === undefined) break;
      const inbox = await session.getJson<{ pending: InboxEntry[] }>('/api/approvals');
      const entry = inbox.pending.find(
        (candidate) => candidate.runId === runId && candidate.entryId === choice.entryId
      );
      if (entry === undefined) break;
      const response = await session.post('/api/approvals/decisions', {
        runId,
        approvalSubjectId: entry.approvalSubjectId,
        expectedRunVersion: entry.runVersion,
        expectedSubjectHash: entry.subjectHash,
        entryId: entry.entryId,
        category: entry.category,
        authority: entry.availableAuthority,
        action: 'approve_unchanged',
        idempotencyKey: `sample-approval-${runId}-${entry.entryId}`,
        rationale: `Reviewed as ${entry.availableAuthority} for the sample artifact set.`
      });
      if (!response.ok) throw new Error(`Decision failed: ${response.status}`);
      const result = (await response.json()) as Record<string, unknown>;
      approvalsApplied += 1;
      progression.push({
        step,
        operableBefore,
        decision: {
          entryId: entry.entryId,
          category: entry.category,
          requiredAuthorities: entry.requiredAuthorities,
          actor: { userId: choice.userId, authority: entry.availableAuthority },
          action: 'approve_unchanged',
          quorumBefore: entry.quorum
        },
        result
      });
      process.stdout.write(
        `${opportunityId}: ${choice.userId} approved ${entry.entryId} (${JSON.stringify(result.status)})\n`
      );
    }
    detail = await pollUntilSettled(requester, runId);
    if (approvalCapturePath !== undefined)
      await writeApprovalFlow({
        databaseUrl,
        capturePath: approvalCapturePath,
        runId,
        requestedBy,
        exportBeforeQuorum,
        progression,
        finalStatus: detail.status,
        finalizedExport: await describeFinalizedExport(requester, runId)
      });
  }
  process.stdout.write(`${opportunityId}: settled as ${detail.status}\n`);
  const briefQuality =
    detail.status === 'completed'
      ? await gradeFinalizedBrief(databaseUrl, opportunityId, runId, requestedBy)
      : undefined;
  return {
    opportunityId,
    requestedBy,
    runId,
    status: detail.status,
    approvalsApplied,
    ...(briefQuality === undefined ? {} : { briefQuality })
  };
}

/**
 * Grades one finalized brief against the same invariants `pnpm eval:brief-quality` audits.
 *
 * Every run is graded and reported, so the operator selecting a sample knows how many live runs
 * were made and what each one produced rather than only seeing the one that was kept.
 */
async function gradeFinalizedBrief(
  databaseUrl: string,
  opportunityId: string,
  runId: string,
  actorId: string
): Promise<SampleRunRecord['briefQuality']> {
  const database = createDatabaseClient(databaseUrl, 2);
  try {
    const exported = await new PostgresBriefExportService(database).exportFinalized({
      actorId,
      runId,
      format: 'json'
    });
    if (exported === undefined) return undefined;
    const report = evaluateBriefQuality(
      JSON.parse(exported.content),
      expectationsForOpportunity(resolve('fixtures/cato'), opportunityId)
    );
    const quality = {
      violations: report.violations.map((violation) => `[${violation.rule}] ${violation.detail}`),
      sourceTypes: report.sourceTypes,
      stakeholders: report.stakeholderNames.length,
      sections: report.sections
    };
    process.stdout.write(
      `${opportunityId}: ${runId} quality - ${quality.violations.length} violation(s), ` +
        `sources ${quality.sourceTypes.join('|') || 'none'}, ` +
        `sections ${JSON.stringify(quality.sections)}\n`
    );
    for (const violation of quality.violations) process.stdout.write(`  ${violation}\n`);
    return quality;
  } finally {
    await database.close();
  }
}

/** Records whether the finalized export became available once the quorum completed. */
async function describeFinalizedExport(
  session: BrowserSession,
  runId: string
): Promise<Readonly<Record<string, unknown>>> {
  const response = await session.request(`/api/runs/${runId}/export/json`);
  const body = await response.text();
  return {
    request: `GET /api/runs/${runId}/export/json`,
    httpStatus: response.status,
    contentLength: body.length,
    attemptedAt: new Date().toISOString()
  };
}

/** Writes the approval-routing artifact from the live capture plus the durable decision rows. */
async function writeApprovalFlow(
  input: Readonly<{
    databaseUrl: string;
    capturePath: string;
    runId: string;
    requestedBy: string;
    exportBeforeQuorum: unknown;
    progression: readonly unknown[];
    finalStatus: string;
    finalizedExport: unknown;
  }>
): Promise<void> {
  const database = createDatabaseClient(input.databaseUrl, 3);
  try {
    const run = (
      await database.sql<
        {
          opportunity_id: string;
          opportunity_name: string;
          account_id: string;
          requester: string;
        }[]
      >`select run.opportunity_id, opportunity.name opportunity_name, opportunity.account_id,
          persona.display_name requester
        from runs run
        join opportunities opportunity on opportunity.id = run.opportunity_id
        join personas persona on persona.id = run.requested_by
        where run.id = ${input.runId}`
    )[0];
    if (run === undefined) throw new Error(`Run not found: ${input.runId}`);
    const subject = (
      await database.sql<
        {
          id: string;
          subject_hash: string;
          policy_triggers: unknown;
          quorum_version: string;
          created_at: Date | string;
        }[]
      >`select id, subject_hash, policy_triggers, quorum_version, created_at
        from approval_subjects where run_id = ${input.runId}
        order by draft_version desc limit 1`
    )[0];
    if (subject === undefined) throw new Error('Run has no approval subject');
    const requirements = await database.sql<
      {
        entry_id: string;
        category: string;
        required_authorities: unknown;
        policy_triggers: unknown;
        depends_on: unknown;
        ordinal: number;
      }[]
    >`select id entry_id, category, eligible_authorities required_authorities,
        policy_triggers, depends_on, ordinal
      from approval_requirement_entries
      where approval_subject_id = ${subject.id}
      order by ordinal`;
    const eligible = await database.sql<
      { authority: string; user_id: string; display_name: string; role: string }[]
    >`select grant_row.authority, persona.id user_id, persona.display_name, persona.role
      from approval_authority_grants grant_row
      join personas persona on persona.id = grant_row.persona_id
      where grant_row.account_id = ${run.account_id}
      order by grant_row.authority, persona.id`;
    const decisions = await database.sql`
      select decision.entry_id, decision.category, decision.authority, decision.action,
        persona.id actor_id, persona.display_name actor_name, decision.rationale,
        decision.result_run_version, decision.result_status,
        decision.result_quorum_satisfied, decision.created_at
      from approval_decisions decision
      join personas persona on persona.id = decision.actor_id
      where decision.approval_subject_id = ${subject.id}
      order by decision.created_at, decision.id`;
    const authorities = (value: unknown): readonly string[] =>
      Array.isArray(value) ? (value as string[]) : [];
    const path = resolve(input.capturePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      json({
        runId: input.runId,
        opportunityId: run.opportunity_id,
        opportunityName: run.opportunity_name,
        authorizedRequester: { userId: input.requestedBy, name: run.requester },
        approvalSubject: {
          id: subject.id,
          subjectHash: subject.subject_hash,
          policyTriggers: subject.policy_triggers,
          quorumVersion: subject.quorum_version,
          required: requirements.length,
          completed: decisions.length,
          createdAt: new Date(subject.created_at).toISOString()
        },
        requirements: requirements.map((requirement) => ({
          ...requirement,
          eligibleApprovers: eligible
            .filter((row) => authorities(requirement.required_authorities).includes(row.authority))
            .map((row) => ({
              userId: row.user_id,
              name: row.display_name,
              role: row.role,
              authority: row.authority,
              isRunRequester: row.user_id === input.requestedBy
            }))
        })),
        exportBeforeQuorum: input.exportBeforeQuorum,
        progression: input.progression,
        decisions,
        finalOutcome: {
          status: input.finalStatus,
          quorumSatisfied: requirements.length > 0 && requirements.length === decisions.length,
          finalizedExport: input.finalizedExport
        }
      }),
      'utf8'
    );
    process.stdout.write(`wrote ${path}\n`);
  } finally {
    await database.close();
  }
}

/** Drives every requested opportunity and reports the runs the exporter should read. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apiBase =
    args.find((arg) => arg.startsWith('--api='))?.slice('--api='.length) ?? DEFAULT_API_BASE;
  const ledgerPath = args.find((arg) => arg.startsWith('--ledger='))?.slice('--ledger='.length);
  const approvalCapturePath = args
    .find((arg) => arg.startsWith('--approval-capture='))
    ?.slice('--approval-capture='.length);
  const opportunities = args.filter((arg) => !arg.startsWith('--'));
  if (opportunities.length === 0)
    throw new Error(
      'Usage: generate-sample-runs.ts [--api=URL] [--ledger=PATH] [--approval-capture=PATH] <opportunity-id...>'
    );
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const records: SampleRunRecord[] = [];
  for (const opportunityId of opportunities)
    records.push(await driveOpportunity(apiBase, databaseUrl, opportunityId, approvalCapturePath));
  const ledger = json(records);
  process.stdout.write(ledger);
  if (ledgerPath !== undefined) await writeFile(resolve(ledgerPath), ledger, 'utf8');
}

await main();
