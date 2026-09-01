import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProcessDealBriefStep,
  type DealBriefGenerationMetadata,
  createEvidenceScopeBinding,
  dealBriefAgentOperations,
  hashEvidenceScopeBinding,
  type DealBriefRetrievalContext,
  type WorkflowCommand
} from '@slacato/core';
import {
  PostgresDealBriefContextRepository,
  PostgresDealBriefWorkflowServices,
  PostgresProviderAttemptLedger,
  PostgresWorkflowStore,
  createConfiguredModelGateways,
  createDatabaseClient,
  type DatabaseClient
} from '@slacato/infrastructure';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const clients: Sql[] = [];
const databases: DatabaseClient[] = [];

function openSql(): Sql {
  const sql = postgres(databaseUrl, { max: 1 });
  clients.push(sql);
  return sql;
}

function openDatabase(): DatabaseClient {
  const database = createDatabaseClient(databaseUrl, 2);
  databases.push(database);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(clients.splice(0).map((client) => client.end({ timeout: 1 })));
});

async function seedGenerationRun(
  sql: Sql,
  database: DatabaseClient,
  suffix: string,
  maxCalls: number
) {
  const userId = `user_trace_attempt_${suffix}`;
  const accountId = `account_trace_attempt_${suffix}`;
  const opportunityId = `opportunity_trace_attempt_${suffix}`;
  const runId = `run_trace_attempt_${suffix}`;
  const command = {
    id: `command_trace_attempt_${suffix}`,
    runId,
    type: 'process-step',
    payload: { step: 'specialists' },
    idempotencyKey: `trace-attempt-${suffix}`
  } as WorkflowCommand;
  await sql`insert into personas (id, display_name, role)
    values (${userId}, 'Trace Attempt User', 'seller')`;
  await sql`insert into accounts (id, name) values (${accountId}, 'Trace Attempt Account')`;
  await sql`insert into opportunities (id, account_id, name, restricted)
    values (${opportunityId}, ${accountId}, 'Trace Attempt Opportunity', false)`;
  await sql`insert into runs
    (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
    values (${runId}, ${opportunityId}, ${userId}, 'specialists_running', 'mock', 'mock-brief', ${'d'.repeat(64)}, 2)`;
  await sql`insert into run_budgets (run_id, max_calls, deadline_ms)
    values (${runId}, ${maxCalls}, 30_000)`;
  await sql`insert into outbox_commands
    (id, run_id, type, payload, idempotency_key, status, published_at)
    values (${command.id}, ${runId}, 'process-step', ${sql.json(command.payload)},
      ${command.idempotencyKey}, 'published', now())`;
  const store = new PostgresWorkflowStore(database);
  const lease = await store.claimStep({
    runId: runId as never,
    step: 'specialists',
    invocationId: `invocation_trace_attempt_${suffix}`,
    causalCommandId: command.id,
    owner: `worker_trace_attempt_${suffix}`,
    leaseMs: 30_000
  });
  if (lease === undefined) throw new Error('Trace attempt fixture did not acquire its workflow lease');
  return { runId, store, lease, ledger: new PostgresProviderAttemptLedger(database) };
}

describe('provider-attempt trace lineage', () => {
  it('projects a completed agent checkpoint from its persisted nonzero provider attempt', async () => {
    const sql = openSql();
    const database = openDatabase();
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const userId = `user_trace_lineage_${suffix}`;
    const accountId = `account_trace_lineage_${suffix}`;
    const opportunityId = `opportunity_trace_lineage_${suffix}`;
    const runId = `run_trace_lineage_${suffix}`;
    const commandId = `command_trace_lineage_${suffix}`;
    const manifestId = `manifest_trace_lineage_${suffix}`;
    const currentScope = {
      personaId: userId,
      allowed: true as const,
      accountIds: [accountId],
      sourceTypes: [
        'gong_summary',
        'gong_transcript',
        'policy',
        'pricing',
        'salesforce',
        'slack'
      ] as const,
      canViewSensitivePricing: true,
      canRequestApproval: true,
      canApprove: false,
      canViewRestrictedAccounts: false
    };
    const binding = createEvidenceScopeBinding({ accountId, opportunityId }, currentScope);
    const scopeHash = hashEvidenceScopeBinding(binding);
    const policyHash = 'c'.repeat(64);
    const evidenceContent = 'The buyer discussed renewal priorities with the account team.';
    const evidenceContentHash = createHash('sha256').update(evidenceContent).digest('hex');
    const gongEvidence = {
      evidenceId: `evidence_trace_lineage_${suffix}`,
      citationId: `citation_trace_lineage_${suffix}`,
      content: evidenceContent,
      contentHash: evidenceContentHash,
      sourceType: 'gong_summary' as const,
      sensitivity: 'internal' as const,
      sourceLocator: `gong/summaries/${suffix}`,
      classificationReason: 'trace lineage fixture',
      policyHash,
      reliabilityClass: 'canonical' as const,
      fusionScore: 1,
      reliabilityAdjustment: 0,
      recencyAdjustment: 0,
      score: 1,
      rank: 1,
      accountId,
      opportunityId
    };
    const context: DealBriefRetrievalContext = {
      runId,
      account: { id: accountId, name: 'Trace Lineage Account' },
      opportunity: { id: opportunityId, name: 'Trace Lineage Opportunity', stage: 'Negotiate' },
      manifest: {
        id: manifestId,
        runId,
        queryHash: 'b'.repeat(64),
        scopeHash,
        policyHash,
        indexProfile: 'mock:mock-embedding:64',
        binding
      },
      currentScope,
      manifestEntries: [
        {
          manifestId,
          accountId,
          opportunityId,
          scopeHash,
          includedCharacters: evidenceContent.length,
          excerptHash: evidenceContentHash,
          evidenceId: gongEvidence.evidenceId,
          citationId: gongEvidence.citationId,
          contentHash: gongEvidence.contentHash,
          sourceLocator: gongEvidence.sourceLocator,
          sourceType: gongEvidence.sourceType,
          sensitivity: gongEvidence.sensitivity,
          policyHash
        }
      ],
      evidence: [gongEvidence]
    };
    const conversation = {
      evidenceManifestId: manifestId,
      goals: [],
      concerns: [],
      commitments: [],
      objections: [],
      missingContext: [],
      claims: [],
      reviewWarnings: []
    };
    const stakeholder = {
      evidenceManifestId: manifestId,
      stakeholders: [],
      coverageGaps: [],
      claims: [],
      reviewWarnings: []
    };
    const commercial = {
      evidenceManifestId: manifestId,
      commercialTerms: [],
      policyTriggers: [],
      claims: [],
      reviewWarnings: []
    };
    const command = {
      id: commandId,
      runId,
      type: 'process-step',
      payload: { step: 'specialists' },
      idempotencyKey: `trace-lineage-${suffix}`
    } as WorkflowCommand;

    await sql`insert into personas (id, display_name, role) values (${userId}, 'Trace Lineage User', 'seller')`;
    await sql`insert into accounts (id, name) values (${accountId}, 'Trace Lineage Account')`;
    await sql`insert into opportunities (id, account_id, name, restricted)
      values (${opportunityId}, ${accountId}, 'Trace Lineage Opportunity', false)`;
    await sql`insert into runs
      (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
      values (${runId}, ${opportunityId}, ${userId}, 'specialists_running', 'mock', 'mock-brief', ${'a'.repeat(64)}, 2)`;
    await sql`insert into run_budgets (run_id, max_calls, deadline_ms)
      values (${runId}, 2, 30_000)`;
    await sql`insert into workflow_checkpoints (id, run_id, step, payload) values
      (${`checkpoint_retrieval_${suffix}`}, ${runId}, 'retrieval', ${sql.json({ status: 'completed', value: context })}),
      (${`checkpoint_stakeholder_${suffix}`}, ${runId}, 'specialist:stakeholder', ${sql.json({ status: 'completed', value: stakeholder })}),
      (${`checkpoint_commercial_${suffix}`}, ${runId}, 'specialist:commercial', ${sql.json({ status: 'completed', value: commercial })})`;
    await sql`insert into outbox_commands
      (id, run_id, type, payload, idempotency_key, status, published_at)
      values (${commandId}, ${runId}, 'process-step', ${sql.json(command.payload)},
        ${command.idempotencyKey}, 'published', now())`;

    const ledger = new PostgresProviderAttemptLedger(database);
    const gateways = createConfiguredModelGateways(
      { AI_PROVIDER: 'mock' } as never,
      {
        attemptLedger: ledger,
        mock: {
          resolve(request) {
            if (request.operation !== 'conversation-intelligence')
              throw new Error(`Unexpected model operation: ${request.operation}`);
            return {
              text: JSON.stringify(conversation),
              usage: { inputTokens: 11, outputTokens: 7 },
              requestId: `request-${request.operation}`,
              responseId: `response-${request.operation}`
            };
          }
        }
      }
    );
    const services = new PostgresDealBriefWorkflowServices(
      new PostgresDealBriefContextRepository(database),
      {} as never,
      gateways
    );
    const serviceInternals = services as unknown as {
      assertContextRemainsAuthorized(): Promise<void>;
    };
    serviceInternals.assertContextRemainsAuthorized = async () => {};
    await new ProcessDealBriefStep(new PostgresWorkflowStore(database), services, {
      leaseMs: 30_000
    }).execute({ command, workerId: `worker-trace-lineage-${suffix}` });

    const checkpoint = (
      await sql<
        {
          invocation_id: string;
          logical_generation_id: string;
          generation_operation: string;
        }[]
      >`select invocation_id, logical_generation_id,
          payload->'generation'->>'operation' as generation_operation
        from workflow_checkpoints
        where run_id = ${runId} and step = 'specialist:conversation'`
    )[0];
    if (checkpoint === undefined) throw new Error('Conversation checkpoint was not persisted');

    const attempts = await sql<
      {
        id: string;
        invocation_id: string;
        logical_generation_id: string;
        operation: string;
        input_tokens: number;
        output_tokens: number;
        reservation_operation: string;
        reservation_logical_generation_id: string;
      }[]
    >`select attempt.id, attempt.invocation_id, attempt.logical_generation_id, attempt.operation,
        attempt.input_tokens, attempt.output_tokens,
        reservation.operation as reservation_operation,
        reservation.logical_generation_id as reservation_logical_generation_id
      from generation_attempts attempt
      left join run_budget_reservations reservation on reservation.attempt_id = attempt.id
      where attempt.run_id = ${runId}
        and attempt.operation in ('conversation', 'conversation-intelligence')
      order by attempt.started_at`;

    expect(attempts).toHaveLength(1);
    const [providerAttempt] = attempts;
    expect(providerAttempt).toBeDefined();
    if (providerAttempt === undefined) throw new Error('Conversation provider attempt was not persisted');
    expect(providerAttempt).toMatchObject({
      invocation_id: checkpoint.invocation_id,
      logical_generation_id: checkpoint.logical_generation_id,
      operation: checkpoint.generation_operation,
      input_tokens: 11,
      output_tokens: 7,
      reservation_operation: checkpoint.generation_operation,
      reservation_logical_generation_id: checkpoint.logical_generation_id
    });

    const spans = await sql<
      { span_id: string; parent_id: string | null; kind: string; payload: Record<string, unknown> }[]
    >`select span_id, parent_id, kind, payload
      from trace_spans
      where run_id = ${runId} and step = 'conversation' and kind in ('model_call', 'usage')
      order by kind`;
    const modelSpan = spans.find((span) => span.kind === 'model_call');
    const usageSpan = spans.find((span) => span.kind === 'usage');
    expect(modelSpan?.payload).toMatchObject({ durableAttemptId: providerAttempt.id });
    expect(usageSpan).toMatchObject({
      parent_id: modelSpan?.span_id,
      payload: { inputTokens: providerAttempt.input_tokens, outputTokens: providerAttempt.output_tokens }
    });
  });

  it('projects a fatal generation failure from the persisted provider attempt', async () => {
    const sql = openSql();
    const database = openDatabase();
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const { runId, store, lease, ledger } = await seedGenerationRun(sql, database, suffix, 2);
    const generation: DealBriefGenerationMetadata = {
      invocationId: lease.invocationId,
      logicalGenerationId: `generation_trace_fatal_${suffix}`,
      operation: dealBriefAgentOperations.commercial,
      provider: 'mock',
      model: 'mock-brief',
      possibleDuplicate: false
    };
    const providerAttempt = await ledger.beginAttempt({
      runScope: runId,
      invocationId: generation.invocationId,
      logicalGenerationId: generation.logicalGenerationId,
      operation: generation.operation,
      provider: generation.provider,
      model: generation.model,
      inputTokens: 13,
      requestedOutputTokens: 9
    });
    await ledger.settleAttempt({
      ...providerAttempt,
      reservedInputTokens: 13,
      actualInputTokens: 13,
      actualOutputTokens: 5,
      requestId: `request_trace_fatal_${suffix}`,
      responseId: `response_trace_fatal_${suffix}`
    });

    await store.failRun({
      runId: runId as never,
      expectedVersion: 2,
      invocationId: lease.invocationId,
      invocationOwner: lease.owner,
      leaseToken: lease.leaseToken,
      causalCommandId: lease.causalCommandId,
      reason: 'commercial_specialist_failed',
      failedGeneration: generation
    });

    const attempts = await sql<
      { id: string; logical_generation_id: string; operation: string; ordinal: number }[]
    >`select id, logical_generation_id, operation, ordinal
      from generation_attempts where run_id = ${runId} order by ordinal`;
    expect(attempts).toEqual([
      {
        id: providerAttempt.attemptId,
        logical_generation_id: generation.logicalGenerationId,
        operation: generation.operation,
        ordinal: providerAttempt.ordinal
      }
    ]);
    const spans = await sql<
      {
        span_id: string;
        parent_id: string | null;
        kind: string;
        status: string;
        payload: Record<string, unknown>;
      }[]
    >`select span_id, parent_id, kind, status, payload
      from trace_spans where run_id = ${runId} and step = 'commercial'
      order by kind, attempt`;
    const attemptSpan = spans.find((span) => span.kind === 'specialist_attempt');
    const modelSpan = spans.find((span) => span.kind === 'model_call');
    const usageSpan = spans.find((span) => span.kind === 'usage');
    expect(attemptSpan).toMatchObject({
      status: 'failed',
      payload: {
        operation: generation.operation,
        logicalGenerationId: generation.logicalGenerationId
      }
    });
    expect(modelSpan).toMatchObject({
      parent_id: attemptSpan?.span_id,
      status: 'completed',
      payload: {
        durableAttemptId: providerAttempt.attemptId,
        logicalGenerationId: generation.logicalGenerationId,
        ordinal: providerAttempt.ordinal
      }
    });
    expect(usageSpan).toMatchObject({
      parent_id: modelSpan?.span_id,
      status: 'completed',
      payload: { inputTokens: 13, outputTokens: 5 }
    });
    expect(
      spans.filter(
        (span) =>
          span.kind === 'validation' || span.kind === 'guardrail' || span.kind === 'repair'
      )
    ).toEqual([]);
  });

  it('marks possible-duplicate and unresolved attempts indeterminate without success spans', async () => {
    const sql = openSql();
    const database = openDatabase();
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const { runId, store, lease, ledger } = await seedGenerationRun(sql, database, suffix, 3);
    const generation: DealBriefGenerationMetadata = {
      invocationId: lease.invocationId,
      logicalGenerationId: `generation_trace_indeterminate_${suffix}`,
      operation: dealBriefAgentOperations.conversation,
      provider: 'mock',
      model: 'mock-brief',
      possibleDuplicate: false
    };
    const firstAttempt = await ledger.beginAttempt({
      runScope: runId,
      invocationId: generation.invocationId,
      logicalGenerationId: generation.logicalGenerationId,
      operation: generation.operation,
      provider: generation.provider,
      model: generation.model,
      inputTokens: 3,
      requestedOutputTokens: 9
    });
    await ledger.releaseAttempt({
      ...firstAttempt,
      disposition: 'possibly_sent',
      category: 'transient_transport'
    });
    const unresolvedAttempt = await ledger.beginAttempt({
      runScope: runId,
      invocationId: generation.invocationId,
      logicalGenerationId: generation.logicalGenerationId,
      operation: generation.operation,
      provider: generation.provider,
      model: generation.model,
      inputTokens: 4,
      requestedOutputTokens: 7
    });

    await store.saveCheckpoint({
      runId: runId as never,
      step: 'specialist:conversation',
      invocationId: lease.invocationId,
      invocationOwner: lease.owner,
      leaseToken: lease.leaseToken,
      logicalGenerationId: generation.logicalGenerationId,
      checkpoint: {
        status: 'completed',
        value: { evidenceManifestId: `manifest_trace_indeterminate_${suffix}` },
        generation
      }
    });

    const attempts = await sql<
      { id: string; ordinal: number; status: string; possible_duplicate: boolean }[]
    >`select id, ordinal, status, possible_duplicate
      from generation_attempts where run_id = ${runId} order by ordinal`;
    expect(attempts).toEqual([
      {
        id: firstAttempt.attemptId,
        ordinal: firstAttempt.ordinal,
        status: 'possible_duplicate',
        possible_duplicate: true
      },
      {
        id: unresolvedAttempt.attemptId,
        ordinal: unresolvedAttempt.ordinal,
        status: 'attempt_started',
        possible_duplicate: false
      }
    ]);
    const spans = await sql<
      {
        span_id: string;
        parent_id: string | null;
        attempt: number;
        kind: string;
        status: string;
        payload: Record<string, unknown>;
      }[]
    >`select span_id, parent_id, attempt, kind, status, payload
      from trace_spans where run_id = ${runId} and step = 'conversation'
      order by attempt, kind`;
    expect(spans.find((span) => span.kind === 'specialist_attempt')).toMatchObject({
      status: 'degraded',
      payload: {
        operation: generation.operation,
        logicalGenerationId: generation.logicalGenerationId
      }
    });
    expect(
      spans
        .filter((span) => span.kind === 'model_call')
        .map((span) => ({
          attempt: span.attempt,
          status: span.status,
          durableAttemptId: span.payload.durableAttemptId,
          possibleDuplicate: span.payload.possibleDuplicate
        }))
    ).toEqual([
      {
        attempt: firstAttempt.ordinal,
        status: 'degraded',
        durableAttemptId: firstAttempt.attemptId,
        possibleDuplicate: true
      },
      {
        attempt: unresolvedAttempt.ordinal,
        status: 'degraded',
        durableAttemptId: unresolvedAttempt.attemptId,
        possibleDuplicate: false
      }
    ]);
    expect(
      spans
        .filter((span) => span.kind === 'usage')
        .map((span) => ({ attempt: span.attempt, status: span.status, payload: span.payload }))
    ).toEqual([
      {
        attempt: firstAttempt.ordinal,
        status: 'degraded',
        payload: { inputTokens: 0, outputTokens: firstAttempt.grantedOutputTokens }
      },
      {
        attempt: unresolvedAttempt.ordinal,
        status: 'degraded',
        payload: { inputTokens: 0, outputTokens: 0 }
      }
    ]);
    expect(spans.filter((span) => span.kind === 'validation' || span.kind === 'guardrail')).toEqual(
      []
    );
  });

  it('rejects completed schema-invalid attempts and accepts only the final clean attempt', async () => {
    const sql = openSql();
    const database = openDatabase();
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const { runId, store, lease, ledger } = await seedGenerationRun(sql, database, suffix, 2);
    const generation: DealBriefGenerationMetadata = {
      invocationId: lease.invocationId,
      logicalGenerationId: `generation_trace_validation_${suffix}`,
      operation: dealBriefAgentOperations.conversation,
      provider: 'mock',
      model: 'mock-brief',
      possibleDuplicate: false
    };
    const invalidAttempt = await ledger.beginAttempt({
      runScope: runId,
      invocationId: generation.invocationId,
      logicalGenerationId: generation.logicalGenerationId,
      operation: generation.operation,
      provider: generation.provider,
      model: generation.model,
      inputTokens: 8,
      requestedOutputTokens: 6
    });
    await ledger.settleAttempt({
      ...invalidAttempt,
      reservedInputTokens: 8,
      actualInputTokens: 8,
      actualOutputTokens: 4
    });
    await ledger.recordAttemptMetadata({
      attemptId: invalidAttempt.attemptId,
      outputMode: 'native_schema',
      validationAttempts: 1,
      validationIssues: [
        { path: 'claims.0.statement', code: 'custom', message: 'Claim is not grounded' }
      ],
      warnings: []
    });
    const cleanAttempt = await ledger.beginAttempt({
      runScope: runId,
      invocationId: generation.invocationId,
      logicalGenerationId: generation.logicalGenerationId,
      operation: generation.operation,
      provider: generation.provider,
      model: generation.model,
      inputTokens: 9,
      requestedOutputTokens: 6
    });
    await ledger.settleAttempt({
      ...cleanAttempt,
      reservedInputTokens: 9,
      actualInputTokens: 9,
      actualOutputTokens: 5
    });
    await ledger.recordAttemptMetadata({
      attemptId: cleanAttempt.attemptId,
      outputMode: 'native_schema',
      validationAttempts: 1,
      validationIssues: [],
      warnings: []
    });

    await store.saveCheckpoint({
      runId: runId as never,
      step: 'specialist:conversation',
      invocationId: lease.invocationId,
      invocationOwner: lease.owner,
      leaseToken: lease.leaseToken,
      logicalGenerationId: generation.logicalGenerationId,
      checkpoint: {
        status: 'completed',
        value: { evidenceManifestId: `manifest_trace_validation_${suffix}` },
        generation
      }
    });

    const spans = await sql<
      {
        span_id: string;
        parent_id: string | null;
        attempt: number;
        kind: string;
        status: string;
        payload: Record<string, unknown>;
      }[]
    >`select span_id, parent_id, attempt, kind, status, payload
      from trace_spans where run_id = ${runId} and step = 'conversation'
      order by attempt, kind`;
    const models = spans.filter((span) => span.kind === 'model_call');
    const invalidModel = models.find((span) => span.attempt === invalidAttempt.ordinal);
    const cleanModel = models.find((span) => span.attempt === cleanAttempt.ordinal);
    expect(invalidModel).toMatchObject({
      status: 'completed',
      payload: { durableAttemptId: invalidAttempt.attemptId }
    });
    expect(cleanModel).toMatchObject({
      status: 'completed',
      payload: { durableAttemptId: cleanAttempt.attemptId }
    });
    expect(
      spans
        .filter((span) => span.kind === 'validation')
        .map((span) => ({
          parentId: span.parent_id,
          attempt: span.attempt,
          status: span.status,
          decision: span.payload.decision
        }))
    ).toEqual([
      {
        parentId: invalidModel?.span_id,
        attempt: invalidAttempt.ordinal,
        status: 'failed',
        decision: 'rejected'
      },
      {
        parentId: cleanModel?.span_id,
        attempt: cleanAttempt.ordinal,
        status: 'completed',
        decision: 'accepted'
      }
    ]);
    expect(
      spans
        .filter((span) => span.kind === 'guardrail')
        .map((span) => ({
          parentId: span.parent_id,
          attempt: span.attempt,
          decision: span.payload.decision
        }))
    ).toEqual([
      {
        parentId: cleanModel?.span_id,
        attempt: cleanAttempt.ordinal,
        decision: 'passed'
      }
    ]);
  });
});
