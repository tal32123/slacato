import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DealBrief,
  dealBriefSchema,
  DomainConflictError,
  hashApprovalPayload
} from '@slacato/core';
import { createDatabaseClient } from '@slacato/infrastructure/db/client';
import { PostgresWorkflowStore } from '@slacato/infrastructure/db/repositories/workflow-store';

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databaseName = `catohw_approval_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
const databaseNamePattern = /^catohw_approval_[a-z0-9]{16}$/;

function databaseUrlFor(name: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const databaseUrl = databaseUrlFor(databaseName);
const database = createDatabaseClient(databaseUrl, 4);
const store = new PostgresWorkflowStore(database);

type ApprovalFixture = Readonly<{
  actorId: string;
  entryId: string;
  payload: DealBrief;
  runId: string;
  subjectHash: string;
  subjectId: string;
}>;

type DecisionInput = Parameters<
  PostgresWorkflowStore['recordDecisionAndEnqueueFinalization']
>[0];
type ReplacementInput = Parameters<PostgresWorkflowStore['replaceApprovalSubject']>[0];

function suffix(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

function approvalBrief(label: string) {
  return dealBriefSchema.parse({
    dealSnapshot: {
      accountName: label,
      opportunityName: `${label} Opportunity`,
      stage: 'Negotiate'
    },
    executiveSummary: {
      narrative: 'Insufficient supported evidence is available for an executive summary.'
    },
    buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
    stakeholderMap: { stakeholders: [] },
    negotiationState: {
      currentState: 'Insufficient supported evidence is available.',
      risks: []
    },
    recommendedNextActions: { actions: [] },
    missingInformation: { items: [] },
    sourceEvidence: { evidence: [] },
    confidenceAndReviewWarnings: { overallConfidence: 0.9, warnings: [] }
  });
}

async function createTemporaryDatabase(): Promise<void> {
  if (!databaseNamePattern.test(databaseName))
    throw new Error(`Refusing to create non-test database ${databaseName}`);
  const maintenance = postgres(databaseUrlFor('postgres'), { max: 1 });
  try {
    await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end({ timeout: 1 });
  }
  const migrationFiles = (await readdir(resolve(process.cwd(), 'drizzle')))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  const target = postgres(databaseUrl, { max: 1 });
  try {
    for (const file of migrationFiles)
      await target.unsafe(await readFile(resolve(process.cwd(), 'drizzle', file), 'utf8'));
  } finally {
    await target.end({ timeout: 1 });
  }
}

async function dropTemporaryDatabase(): Promise<void> {
  if (!databaseNamePattern.test(databaseName))
    throw new Error(`Refusing to drop non-test database ${databaseName}`);
  const maintenance = postgres(databaseUrlFor('postgres'), { max: 1 });
  try {
    await maintenance`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName} and pid <> pg_backend_pid()`;
    await maintenance.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await maintenance.end({ timeout: 1 });
  }
}

async function seedApproval(label: string): Promise<ApprovalFixture> {
  const id = suffix();
  const actorId = `user_approval_${id}`;
  const accountId = `account_approval_${id}`;
  const opportunityId = `opportunity_approval_${id}`;
  const runId = `run_approval_${id}`;
  const subjectId = `approval_subject_${id}`;
  const entryId = `approval_entry_${id}`;
  const payload = approvalBrief(label);
  const subjectHash = hashApprovalPayload(payload);

  await database.sql`insert into personas (id, display_name, role) values (${actorId}, 'Approval actor', 'approver')`;
  await database.sql`insert into accounts (id, name) values (${accountId}, ${label})`;
  await database.sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, ${`${label} Opportunity`})`;
  await database.sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, idempotency_key, start_request_hash, version)
    values (${runId}, ${opportunityId}, ${actorId}, 'awaiting_approval', 'mock', 'mock-brief', ${`start_${id}`}, ${`start_hash_${id}`}, 5)`;
  await database.sql`insert into approval_subjects
    (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
    values (${subjectId}, ${runId}, 5, ${subjectHash}, ${JSON.stringify(payload)}::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'approval-concurrency-v1')`;
  await database.sql`insert into approval_requirement_entries
    (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
    values (${entryId}, ${subjectId}, 'legal_terms', '["legal_reviewer"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0)`;

  return { actorId, entryId, payload, runId, subjectHash, subjectId };
}

function unchangedDecision(
  fixture: ApprovalFixture,
  idempotencyKey: string,
  requestHash: string
): DecisionInput {
  return {
    runId: fixture.runId as DecisionInput['runId'],
    expectedVersion: 5,
    approvalSubjectId: fixture.subjectId,
    expectedSubjectHash: fixture.subjectHash,
    entryId: fixture.entryId,
    category: 'legal_terms',
    authority: 'legal_reviewer',
    actorId: fixture.actorId as DecisionInput['actorId'],
    idempotencyKey,
    requestHash,
    decision: {
      action: 'approve_unchanged',
      entryId: fixture.entryId,
      category: 'legal_terms',
      authority: 'legal_reviewer',
      actorId: fixture.actorId as DecisionInput['actorId'],
      originalPayload: fixture.payload,
      approvedPayload: fixture.payload,
      approvedSubjectHash: fixture.subjectHash,
      requestHash,
      decidedAt: new Date().toISOString()
    },
    finalizationCommand: {
      id: `command_${idempotencyKey}`,
      runId: fixture.runId as DecisionInput['runId'],
      type: 'process-deal-brief-step',
      payload: { step: 'finalize' },
      idempotencyKey: `finalize_${idempotencyKey}`
    }
  };
}

function replacementDecision(
  fixture: ApprovalFixture,
  idempotencyKey: string,
  requestHash: string,
  replacementLabel = 'Edited approval'
): ReplacementInput {
  const replacementPayload = approvalBrief(replacementLabel);
  const replacementSubjectHash = hashApprovalPayload(replacementPayload);
  const identity = hashApprovalPayload({ idempotencyKey, requestHash });
  return {
    runId: fixture.runId as ReplacementInput['runId'],
    expectedVersion: 5,
    priorSubjectId: fixture.subjectId,
    idempotencyKey,
    requestHash,
    priorDecision: {
      action: 'edit_and_approve',
      entryId: fixture.entryId,
      category: 'legal_terms',
      authority: 'legal_reviewer',
      actorId: fixture.actorId as ReplacementInput['priorDecision']['actorId'],
      originalPayload: fixture.payload,
      approvedPayload: replacementPayload,
      editedPayload: replacementPayload,
      approvedSubjectHash: replacementSubjectHash,
      diff: { replacementLabel },
      rationale: 'The approved language was edited.',
      requestHash,
      decidedAt: new Date().toISOString()
    },
    subject: {
      id: `approval_subject_replacement_${identity}`,
      runId: fixture.runId as ReplacementInput['runId'],
      subjectHash: replacementSubjectHash,
      payload: replacementPayload,
      sectionIds: [],
      recommendationIds: [],
      citationIds: [],
      policyTriggers: [],
      entries: [
        {
          id: `approval_entry_replacement_${identity}`,
          category: 'legal_terms',
          eligibleAuthorities: ['legal_reviewer'],
          policyTriggers: [],
          dependsOn: []
        }
      ],
      quorumVersion: 'approval-concurrency-v2'
    }
  };
}

async function durableCounts(runId: string, idempotencyKey: string) {
  return (
    await database.sql<
      {
        commands: number;
        decisions: number;
        events: number;
        subjects: number;
      }[]
    >`select
      (select count(*)::int from approval_decisions where idempotency_key = ${idempotencyKey}) decisions,
      (select count(*)::int from approval_subjects where run_id = ${runId}) subjects,
      (select count(*)::int from run_events where run_id = ${runId}) events,
      (select count(*)::int from outbox_commands where run_id = ${runId}) commands`
  )[0];
}

function fulfilled<T>(outcomes: PromiseSettledResult<T>[]): PromiseFulfilledResult<T>[] {
  return outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<T> => outcome.status === 'fulfilled'
  );
}

function rejected<T>(outcomes: PromiseSettledResult<T>[]): PromiseRejectedResult[] {
  return outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  );
}

async function concurrentlyWhileRunLocked<T>(
  runId: string,
  submissions: readonly [() => Promise<T>, () => Promise<T>]
): Promise<PromiseSettledResult<T>[]> {
  // Hold the CAS row until both submissions reach either the run lock or the approval-key lock.
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = database.sql.begin(async (sql) => {
    await sql`select id from runs where id = ${runId} for update`;
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const [first, second] = submissions;
  const outcomes = Promise.allSettled([first(), second()]);
  try {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const active = (
        await database.sql<{ count: number }[]>`select count(*)::int count
          from pg_stat_activity
          where datname = current_database() and state = 'active'
            and (
              query ilike '%from runs where id =%for update%'
              or query ilike '%pg_advisory_xact_lock(hashtext%'
            )`
      )[0]?.count;
      if (active !== undefined && active >= submissions.length) break;
      if (attempt === 999)
        throw new Error('Concurrent approval transactions did not overlap');
      const turn = Promise.withResolvers<void>();
      setImmediate(turn.resolve);
      await turn.promise;
    }
  } finally {
    release.resolve();
    await blocker;
  }
  return outcomes;
}

beforeAll(createTemporaryDatabase);
afterAll(async () => {
  await database.close();
  await dropTemporaryDatabase();
});

describe('PostgresWorkflowStore approval idempotency concurrency', () => {
  it('replays concurrent identical unchanged approvals with one durable mutation', async () => {
    const fixture = await seedApproval('Concurrent unchanged approval');
    const idempotencyKey = `unchanged_${suffix()}`;
    const input = unchangedDecision(fixture, idempotencyKey, `request_${suffix()}`);

    const settled = await concurrentlyWhileRunLocked(fixture.runId, [
      () => store.recordDecisionAndEnqueueFinalization(input),
      () => store.recordDecisionAndEnqueueFinalization(input)
    ]);
    expect(rejected(settled)).toHaveLength(0);
    const outcomes = fulfilled(settled).map(({ value }) => value);

    expect(outcomes.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    const original = outcomes.find(({ replayed }) => !replayed);
    const replay = outcomes.find(({ replayed }) => replayed);
    if (original === undefined || replay === undefined)
      throw new Error('Concurrent unchanged approval did not return original and replay results');
    expect(replay).toEqual({ ...original, replayed: true });
    expect(original.run).toMatchObject({ id: fixture.runId, status: 'finalizing', version: 6 });
    expect(await durableCounts(fixture.runId, idempotencyKey)).toEqual({
      decisions: 1,
      subjects: 1,
      events: 1,
      commands: 1
    });
  });

  it('preserves the idempotency conflict for concurrent unchanged approvals with the same key', async () => {
    const fixture = await seedApproval('Concurrent conflicting unchanged approval');
    const idempotencyKey = `unchanged_conflict_${suffix()}`;
    const first = unchangedDecision(fixture, idempotencyKey, `request_first_${suffix()}`);
    const second = unchangedDecision(fixture, idempotencyKey, `request_second_${suffix()}`);

    const outcomes = await concurrentlyWhileRunLocked(fixture.runId, [
      () => store.recordDecisionAndEnqueueFinalization(first),
      () => store.recordDecisionAndEnqueueFinalization(second)
    ]);

    expect(fulfilled(outcomes)).toHaveLength(1);
    expect(rejected(outcomes)).toHaveLength(1);
    expect(rejected(outcomes)[0]?.reason).toBeInstanceOf(DomainConflictError);
    expect(rejected(outcomes)[0]?.reason).toMatchObject({
      message: 'Decision idempotency key conflicts with another decision'
    });
    expect(await durableCounts(fixture.runId, idempotencyKey)).toEqual({
      decisions: 1,
      subjects: 1,
      events: 1,
      commands: 1
    });
  });

  it('replays concurrent identical edit-and-approve replacements with one durable mutation', async () => {
    const fixture = await seedApproval('Concurrent replacement approval');
    const idempotencyKey = `replacement_${suffix()}`;
    const input = replacementDecision(fixture, idempotencyKey, `request_${suffix()}`);

    const settled = await concurrentlyWhileRunLocked(fixture.runId, [
      () => store.replaceApprovalSubject(input),
      () => store.replaceApprovalSubject(input)
    ]);
    expect(rejected(settled)).toHaveLength(0);
    const outcomes = fulfilled(settled).map(({ value }) => value);

    expect(outcomes.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    const original = outcomes.find(({ replayed }) => !replayed);
    const replay = outcomes.find(({ replayed }) => replayed);
    if (original === undefined || replay === undefined)
      throw new Error('Concurrent replacement did not return original and replay results');
    expect(replay).toEqual({ ...original, replayed: true });
    expect(original.run).toMatchObject({
      id: fixture.runId,
      status: 'awaiting_approval',
      version: 6
    });
    expect(await durableCounts(fixture.runId, idempotencyKey)).toEqual({
      decisions: 1,
      subjects: 2,
      events: 1,
      commands: 0
    });
  });

  it('preserves the idempotency conflict for concurrent replacements with the same key', async () => {
    const fixture = await seedApproval('Concurrent conflicting replacement');
    const idempotencyKey = `replacement_conflict_${suffix()}`;
    const first = replacementDecision(
      fixture,
      idempotencyKey,
      `request_first_${suffix()}`,
      'First replacement payload'
    );
    const second = replacementDecision(
      fixture,
      idempotencyKey,
      `request_second_${suffix()}`,
      'Second replacement payload'
    );

    const outcomes = await concurrentlyWhileRunLocked(fixture.runId, [
      () => store.replaceApprovalSubject(first),
      () => store.replaceApprovalSubject(second)
    ]);

    expect(fulfilled(outcomes)).toHaveLength(1);
    expect(rejected(outcomes)).toHaveLength(1);
    expect(rejected(outcomes)[0]?.reason).toBeInstanceOf(DomainConflictError);
    expect(rejected(outcomes)[0]?.reason).toMatchObject({
      message: 'Decision idempotency key conflicts with another decision'
    });
    expect(await durableCounts(fixture.runId, idempotencyKey)).toEqual({
      decisions: 1,
      subjects: 2,
      events: 1,
      commands: 0
    });
  });
});
