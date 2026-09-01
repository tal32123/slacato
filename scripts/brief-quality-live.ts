import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type {
  CommandQueue,
  DealBrief,
  WorkflowCommand,
  WorkflowRun
} from '../packages/core/src/index.js';
import { ProcessDealBriefStep } from '../packages/core/src/index.js';
import {
  createConfiguredModelGateways,
  createDatabaseClient,
  EmbeddingIndexer,
  OutboxDispatcher,
  PostgresBriefExportService,
  PostgresDealBriefContextRepository,
  PostgresDealBriefPolicyFacts,
  PostgresDealBriefWorkflowServices,
  PostgresProviderAttemptLedger,
  PostgresWorkflowStore,
  parseEnv,
  resolveProviderModels
} from '../packages/infrastructure/src/index.js';
import { evaluateBriefQuality, expectationsForOpportunity } from './brief-quality.js';
import { resolveEmbeddingIndexConfiguration } from './index-embeddings.js';
import { ingestFixtureRecords } from './ingest.js';

/**
 * Live end-to-end brief-quality evaluation.
 *
 * The deterministic tier (`pnpm eval:brief-quality`, plus the unit suites) measures artifacts and
 * the validation pass without spending a token. This tier answers the question those cannot: does
 * a real model, given the real authorized manifest, produce a brief a reviewer can use? It is
 * deliberately opt-in - it creates a database, embeds the whole corpus, and makes four generation
 * calls per run - and it is never part of routine CI.
 *
 * Usage:
 *   BRIEF_QUALITY_LIVE=1 AI_PROVIDER=openrouter OPENROUTER_API_KEY=... \
 *     SESSION_SECRET=<32+ chars> pnpm eval:brief-quality:live [OPP-1001 ...]
 *
 * The run drives the same workflow services the worker composes, so the brief it evaluates travels
 * the production path: authorized retrieval, three specialists, strategy synthesis, and the
 * grounding validation applied to every one of them.
 */

const DEFAULT_OPPORTUNITIES = ['OPP-1001'] as const;
const REQUESTER_BY_OPPORTUNITY: Readonly<Record<string, string>> = {
  'OPP-1001': 'USR-5001',
  'OPP-1002': 'USR-5002',
  'OPP-1003': 'USR-5003'
};

/** Refuses to run unless the operator has explicitly opted into live model spend. */
function assertOptedIn(): void {
  if (process.env.BRIEF_QUALITY_LIVE !== '1') {
    throw new Error(
      'Live brief-quality evaluation is opt-in. Set BRIEF_QUALITY_LIVE=1 to authorize model spend.'
    );
  }
  if (process.env.AI_PROVIDER === undefined || process.env.AI_PROVIDER === 'mock') {
    throw new Error(
      'Live brief-quality evaluation requires a real AI_PROVIDER (ollama or openrouter).'
    );
  }
}

/** Drives one run to a terminal state through the real workflow, with an in-process command pump. */
async function driveRun(
  store: PostgresWorkflowStore,
  dispatcher: OutboxDispatcher,
  pending: WorkflowCommand[],
  processor: ProcessDealBriefStep,
  runId: WorkflowRun['id']
): Promise<WorkflowRun> {
  const terminal = ['completed', 'rejected', 'failed', 'cancelled', 'awaiting_approval'];
  for (let step = 0; step < 64; step += 1) {
    await dispatcher.dispatchBatch();
    const command = pending.shift();
    if (command === undefined) break;
    await processor.execute({ command, workerId: 'brief-quality-live' });
    const run = await store.getRun(runId);
    if (run !== undefined && terminal.includes(run.status) && pending.length === 0) break;
  }
  const run = await store.getRun(runId);
  if (run === undefined) throw new Error(`Run disappeared: ${runId}`);
  return run;
}

/**
 * Reads the brief a successful run produced, preferring the finalized export over the draft.
 *
 * Exactly two run states are accepted. `completed` is the finalized brief. `awaiting_approval` is a
 * run whose policy facts require a human decision: it has no finalized export, so the first draft
 * checkpoint is read instead - that is the artifact the approver reads, and it has already passed
 * the same grounding validation, so the invariants apply to it unchanged. Only draft version 1 is
 * read: a regeneration cycle is outside what this evaluation drives.
 *
 * Every other status is a hard failure, deliberately. The synthesis step persists `strategy:1`
 * before the validation step runs, so a run that terminally fails validation - or one the command
 * pump abandons short of a terminal state - still leaves a draft behind. Scoring that draft would
 * report a green brief quality for a run that never succeeded, and this evaluation is the evidence
 * the submission offers that a real model produces a usable brief. It must not be reportable
 * without the run that earned it.
 */
export async function readBrief(
  exporter: Pick<PostgresBriefExportService, 'exportFinalized'>,
  store: Pick<PostgresWorkflowStore, 'getCheckpoint'>,
  run: WorkflowRun
): Promise<DealBrief> {
  if (run.status !== 'completed' && run.status !== 'awaiting_approval') {
    throw new Error(
      `Run ${run.id} did not succeed (status ${run.status}); refusing to report brief quality for it. ` +
        'A draft checkpoint can outlive a run that failed validation, so it is not evidence of quality.'
    );
  }
  if (run.status === 'completed') {
    const exported = await exporter.exportFinalized({
      actorId: run.requestedBy,
      runId: run.id,
      format: 'json'
    });
    if (exported !== undefined) return JSON.parse(exported.content) as DealBrief;
  }
  const checkpoint = await store.getCheckpoint({ runId: run.id, step: 'strategy:1' });
  if (checkpoint?.value === undefined)
    throw new Error(`Run ${run.id} produced no brief (status ${run.status})`);
  return checkpoint.value as DealBrief;
}

/** Evaluates every requested deal against the brief-quality invariants using a live model. */
async function main(): Promise<void> {
  assertOptedIn();
  const opportunities =
    process.argv.slice(2).length > 0 ? process.argv.slice(2) : [...DEFAULT_OPPORTUNITIES];
  const baseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
  const databaseName = `slacato_briefq_${randomUUID().replaceAll('-', '')}`;
  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  const admin = postgres(baseUrl, { max: 1 });
  let database: ReturnType<typeof createDatabaseClient> | undefined;
  let failed = 0;
  try {
    await admin.unsafe(`create database "${databaseName}"`);
    database = createDatabaseClient(isolatedUrl.toString(), 6);
    await migrate(drizzle(database.sql), { migrationsFolder: resolve('drizzle') });
    await ingestFixtureRecords({
      root: resolve('fixtures/cato'),
      databaseUrl: isolatedUrl.toString()
    });
    const embedding = await resolveEmbeddingIndexConfiguration(process.env);
    await new EmbeddingIndexer(database, embedding.gateway, embedding.profile).index();

    const environment = parseEnv({
      ...process.env,
      DATABASE_URL: isolatedUrl.toString(),
      SESSION_SECRET:
        process.env.SESSION_SECRET ?? 'brief-quality-live-session-secret-that-is-long-enough'
    });
    const models = resolveProviderModels(environment);
    const gateways = createConfiguredModelGateways(environment, {
      attemptLedger: new PostgresProviderAttemptLedger(database)
    } as never);
    const store = new PostgresWorkflowStore(database);
    const services = new PostgresDealBriefWorkflowServices(
      new PostgresDealBriefContextRepository(database),
      new PostgresDealBriefPolicyFacts(database),
      gateways
    );
    // An in-process command pump replaces Redis: the outbox, the state machine, the leases and the
    // grounding validation are all the production ones, but the evaluation needs no broker.
    const pending: WorkflowCommand[] = [];
    const queue: CommandQueue = {
      async publish(command) {
        pending.push(command);
      }
    };
    const dispatcher = new OutboxDispatcher(database, queue, queue);
    const processor = new ProcessDealBriefStep(store, services, { leaseMs: 120_000 });
    const exporter = new PostgresBriefExportService(database);

    for (const opportunityId of opportunities) {
      const requestedBy = REQUESTER_BY_OPPORTUNITY[opportunityId];
      if (requestedBy === undefined)
        throw new Error(`No authorized requester is configured for ${opportunityId}`);
      const runId = `run_briefq_${randomUUID().replaceAll('-', '')}`;
      const run = await store.startRun({
        id: runId as WorkflowRun['id'],
        opportunityId: opportunityId as WorkflowRun['opportunityId'],
        requestedBy: requestedBy as WorkflowRun['requestedBy'],
        status: 'created',
        generationProvider: environment.AI_PROVIDER,
        generationModel: models.generation,
        startRequestHash: `brief-quality-live:${runId}`,
        idempotencyKey: runId,
        command: {
          id: `command_${runId}`,
          runId,
          type: 'process-deal-brief-step',
          payload: { step: 'start' },
          idempotencyKey: `${runId}:start:v1`
        } as Parameters<typeof store.startRun>[0]['command'],
        budget: { scope: runId, maxCalls: 24, deadlineMs: 900_000 }
      });
      const finished = await driveRun(store, dispatcher, pending, processor, run.id);
      const brief = await readBrief(exporter, store, finished);
      const report = evaluateBriefQuality(
        brief,
        expectationsForOpportunity(resolve('fixtures/cato'), opportunityId)
      );
      process.stdout.write(
        `\n${opportunityId} (${environment.AI_PROVIDER}/${models.generation}, run ${finished.status})\n`
      );
      process.stdout.write(
        `  source types: ${report.sourceTypes.join(', ') || 'none'}\n` +
          `  stakeholders: ${report.stakeholderNames.join(', ') || 'none'}\n` +
          `  section sizes: ${JSON.stringify(report.sections)}\n`
      );
      if (report.violations.length === 0) {
        process.stdout.write('  PASS - no brief-quality violations\n');
        continue;
      }
      failed += report.violations.length;
      process.stdout.write(`  FAIL - ${report.violations.length} violation(s)\n`);
      for (const violation of report.violations)
        process.stdout.write(`    [${violation.rule}] ${violation.detail}\n`);
    }
    process.stdout.write(`\nTotal live brief-quality violations: ${failed}\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await database?.close();
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await admin.end({ timeout: 1 });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
