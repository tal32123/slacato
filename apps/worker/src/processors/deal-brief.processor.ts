import { createHash } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import {
  CANONICAL_FIXTURE_COMMIT, CommercialAgent, ConversationAgent, StrategyAgent, StakeholderAgent, ProcessDealBriefStep,
  authorizeOpportunity, createEvidenceScopeBinding, dealBriefSchema, hashEvidenceScopeBinding,
  type AgentContext, type ApprovalRequirementInput, type DealBrief, type DealBriefWorkflowServices,
  type PermissionGrant, type StrategyArtifacts, type WorkflowCommand, type WorkflowRun
} from '@slacato/core';
import {
  logger, PostgresDealBriefPolicyFacts, PostgresHybridEvidenceRetriever, WORKFLOW_QUEUE_NAME,
  type ConfiguredModelGateways, type DatabaseClient
} from '@slacato/infrastructure';

type DurableContext = Omit<AgentContext, 'generation'>;
type OpportunityRow = Readonly<{ account_id: string; account_name: string; opportunity_name: string; restricted: boolean }>;
type GrantRow = Readonly<{ accountId: string; source_type: PermissionGrant['sourceType']; canRead: boolean; canReadRestricted: boolean; canRequestApproval: boolean; canApprove: boolean; sensitivePricing: boolean }>;
type BudgetRow = Readonly<{ max_calls: number; max_input_tokens: number; max_output_tokens: number; deadline_ms: number }>;
const MAX_GENERATION_OUTPUT_TOKENS = 4_096;

/** Production workflow services reconstruct live authorization and a run-scoped gateway before every provider call. */
export class PostgresDealBriefWorkflowServices implements DealBriefWorkflowServices {
  private readonly policies: PostgresDealBriefPolicyFacts;
  public constructor(private readonly database: DatabaseClient, private readonly gateways: ConfiguredModelGateways) {
    this.policies = new PostgresDealBriefPolicyFacts(database);
  }

  public async retrieve(run: WorkflowRun, invocationId: string): Promise<Readonly<Record<string, unknown>>> {
    this.assertConfiguredModel(run);
    const opportunity = (await this.database.sql<OpportunityRow[]>`select opportunity.account_id, account.name account_name,
      opportunity.name opportunity_name, opportunity.restricted from opportunities opportunity
      join accounts account on account.id = opportunity.account_id where opportunity.id = ${run.opportunityId}`)[0];
    if (opportunity === undefined) throw new Error('Authorized opportunity context is unavailable');
    const grants = await this.readGrants(run.requestedBy, opportunity.account_id);
    const authorized = authorizeOpportunity({ userId: run.requestedBy, grants }, { accountId: opportunity.account_id, restricted: opportunity.restricted });
    if (!authorized.allowed) throw new Error('Authorized opportunity context is unavailable');
    const configuredEmbedding = this.gateways.registry.resolve('embedding');
    const profile = (await this.database.sql<{ provider: string; model: string; dimension: number; profile: string; version: string; normalization: string }[]>`select embedding_provider provider, embedding_model model, embedding_dimension dimension,
      embedding_profile profile, embedding_version version, embedding_normalization normalization from evidence_versions
      where embedding is not null and account_id = ${opportunity.account_id}
        and embedding_provider = ${configuredEmbedding.providerId} and embedding_model = ${configuredEmbedding.modelId}
      order by created_at desc limit 1`)[0];
    if (profile === undefined) throw new Error('Authorized evidence index is unavailable');
    const budget = await this.budgetFor(run.id);
    const logicalGenerationId = this.generationId(run.id, 'retrieval-embedding');
    const embeddingGateway = await this.gateways.embeddingForRun({ runScope: run.id, invocationId, logicalGenerationId, budget });
    const currentScope = { ...authorized, personaId: run.requestedBy };
    const result = await new PostgresHybridEvidenceRetriever(this.database, embeddingGateway, profile).search({
      query: `${opportunity.opportunity_name} negotiation commercial terms stakeholders`, accountId: opportunity.account_id,
      opportunityId: run.opportunityId, runId: run.id, scope: currentScope, limit: 20, maxContextCharacters: 60_000
    });
    const evidence = result.evidence.map((record) => ({ ...record, accountId: opportunity.account_id, opportunityId: run.opportunityId }));
    const context: DurableContext = {
      runId: run.id,
      account: { id: opportunity.account_id, name: opportunity.account_name },
      opportunity: { id: run.opportunityId, name: opportunity.opportunity_name, stage: 'Unknown' },
      manifest: result.manifest,
      currentScope,
      evidence,
      manifestEntries: evidence.map((record) => ({
        manifestId: result.manifest.id, evidenceId: record.evidenceId, citationId: record.citationId, contentHash: record.contentHash,
        sourceLocator: record.sourceLocator, sourceType: record.sourceType, sensitivity: record.sensitivity, policyHash: record.policyHash,
        includedCharacters: record.content.length, excerptHash: createHash('sha256').update(record.content).digest('hex'),
        accountId: opportunity.account_id, opportunityId: run.opportunityId, scopeHash: result.manifest.scopeHash,
        ...(record.eventDate === undefined ? {} : { eventDate: record.eventDate })
      }))
    };
    return { ...context };
  }

  public async conversation(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string) {
    const { agentContext, gateway } = await this.agentContext(run, context, invocationId, 'conversation-intelligence');
    return { ...await new ConversationAgent(gateway).run(agentContext) };
  }
  public async stakeholder(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string) {
    const { agentContext, gateway } = await this.agentContext(run, context, invocationId, 'stakeholder-mapping');
    return { ...await new StakeholderAgent(gateway).run(agentContext) };
  }
  public async commercial(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string) {
    const { agentContext, gateway } = await this.agentContext(run, context, invocationId, 'commercial-policy');
    return { ...await new CommercialAgent(gateway).run(agentContext) };
  }
  public async strategy(run: WorkflowRun, input: Readonly<{ context: Readonly<Record<string, unknown>>; conversation: Readonly<Record<string, unknown>>; stakeholder: Readonly<Record<string, unknown>>; commercial: Readonly<Record<string, unknown>> }>, invocationId: string): Promise<DealBrief> {
    const { agentContext, gateway } = await this.agentContext(run, input.context, invocationId, 'negotiation-strategy');
    const artifacts: StrategyArtifacts = {
      conversation: input.conversation as StrategyArtifacts['conversation'],
      stakeholder: input.stakeholder as StrategyArtifacts['stakeholder'],
      commercial: input.commercial as StrategyArtifacts['commercial']
    };
    return new StrategyAgent(gateway).run(agentContext, artifacts);
  }
  public approvalInput(run: WorkflowRun, brief: DealBrief): Promise<ApprovalRequirementInput> { return this.policies.forBrief(run.opportunityId, brief); }
  public validateDraft(payload: unknown): DealBrief { return dealBriefSchema.parse(payload); }

  private async agentContext(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string, operation: string) {
    this.assertConfiguredModel(run);
    const durable = context as unknown as DurableContext;
    await this.reauthorizeContext(run, durable);
    const budget = await this.budgetFor(run.id);
    const logicalGenerationId = this.generationId(run.id, operation);
    const limits = { maxCalls: 3, maxSchemaRepairs: 1, maxTransportRetries: 1, deadlineMs: budget.deadlineMs, maxInputTokens: budget.maxInputTokens, maxOutputTokens: Math.min(budget.maxOutputTokens, MAX_GENERATION_OUTPUT_TOKENS) };
    const durableAttempt = { runScope: run.id, invocationId, logicalGenerationId, provider: run.generationProvider, model: run.generationModel };
    const gateway = await this.gateways.forRun({ runScope: run.id, invocationId, logicalGenerationId, budget });
    const agentContext: AgentContext = { ...durable, generation: { durableAttempt, limits } };
    return { gateway, agentContext };
  }

  private async reauthorizeContext(run: WorkflowRun, durable: DurableContext): Promise<void> {
    const opportunity = (await this.database.sql<{ account_id: string; restricted: boolean }[]>`select account_id, restricted from opportunities where id = ${run.opportunityId}`)[0];
    if (opportunity === undefined || durable.account.id !== opportunity.account_id || durable.opportunity.id !== run.opportunityId) throw new Error('Current opportunity authorization is unavailable');
    const grants = await this.readGrants(run.requestedBy, opportunity.account_id);
    const authorization = authorizeOpportunity({ userId: run.requestedBy, grants }, { accountId: opportunity.account_id, restricted: opportunity.restricted });
    if (!authorization.allowed) throw new Error('Current opportunity authorization is unavailable');
    const currentScope = { ...authorization, personaId: run.requestedBy };
    const scopeHash = hashEvidenceScopeBinding(createEvidenceScopeBinding({ accountId: opportunity.account_id, opportunityId: run.opportunityId }, currentScope));
    if (scopeHash !== durable.manifest.scopeHash || durable.evidence.some((record) => !currentScope.sourceTypes.includes(record.sourceType)
      || (record.sourceType === 'pricing' && record.sensitivity === 'sensitive' && !currentScope.canViewSensitivePricing)
      || (opportunity.restricted && !currentScope.canViewRestrictedAccounts))) throw new Error('Evidence authorization changed before generation');
    const persisted = await this.database.sql<{ citation_id: string; evidence_version_id: string; source_locator: string }[]>`select citation_id, evidence_version_id, source_locator
      from run_evidence_manifest_entries where manifest_id = ${durable.manifest.id}`;
    const expected = new Set(durable.manifestEntries.map((entry) => `${entry.citationId}\u0000${entry.evidenceId}\u0000${entry.sourceLocator}`));
    if (persisted.length !== expected.size || persisted.some((entry) => !expected.has(`${entry.citation_id}\u0000${entry.evidence_version_id}\u0000${entry.source_locator}`))) throw new Error('Immutable evidence manifest no longer matches generation context');
  }

  private async readGrants(personaId: string, accountId: string): Promise<PermissionGrant[]> {
    const rows = await this.database.sql<GrantRow[]>`select account_id "accountId", source_type,
      can_read "canRead", can_read_restricted "canReadRestricted", can_request_approval "canRequestApproval", can_approve "canApprove", sensitive_pricing "sensitivePricing"
      from permission_grants where persona_id = ${personaId} and account_id = ${accountId}
        and source_commit = ${CANONICAL_FIXTURE_COMMIT}`;
    return rows.map(({ source_type, ...grant }) => ({ ...grant, sourceType: source_type }));
  }
  private async budgetFor(runId: string) {
    const budget = (await this.database.sql<BudgetRow[]>`select max_calls, max_input_tokens, max_output_tokens, deadline_ms from run_budgets where run_id = ${runId}`)[0];
    if (budget === undefined) throw new Error('Run budget is unavailable');
    return { scope: runId, maxCalls: budget.max_calls, maxInputTokens: budget.max_input_tokens, maxOutputTokens: budget.max_output_tokens, deadlineMs: budget.deadline_ms };
  }
  private assertConfiguredModel(run: WorkflowRun): void {
    const configured = this.gateways.registry.resolve('brief');
    if (run.generationProvider !== this.gateways.provider || run.generationModel !== configured.modelId) throw new Error('Persisted run model identity does not match worker configuration');
  }
  private generationId(runId: string, operation: string): string { return `generation_${createHash('sha256').update(`${runId}\u0000${operation}`).digest('hex')}`; }
}

export type DealBriefProcessorOptions = Readonly<{ redisUrl: string; workerId: string; concurrency?: number; jobsPerSecond?: number; lockDurationMs?: number }>;

/** Thin BullMQ delivery adapter. Model retry policy remains exclusively inside BudgetedModelGateway. */
export class DealBriefProcessor {
  private readonly worker: Worker<WorkflowCommand, void, 'workflow-command'>;
  public constructor(processStep: ProcessDealBriefStep, options: DealBriefProcessorOptions) {
    const concurrency = options.concurrency ?? 1; const jobsPerSecond = options.jobsPerSecond ?? 2; const lockDuration = options.lockDurationMs ?? 120_000;
    if (!Number.isInteger(concurrency) || concurrency !== 1) throw new RangeError('Initial deal brief worker concurrency must be exactly one');
    if (!Number.isInteger(jobsPerSecond) || jobsPerSecond < 1) throw new RangeError('Worker rate limit must be positive');
    this.worker = new Worker<WorkflowCommand, void, 'workflow-command'>(WORKFLOW_QUEUE_NAME, async (job: Job<WorkflowCommand, void, 'workflow-command'>) => {
      const startedAt = Date.now();
      const correlationId = String(job.id ?? job.data.id);
      const attempt = job.attemptsMade + 1;
      logger.info({
        event: 'workflow_command_started', correlationId, runId: job.data.runId, attemptId: job.data.id,
        status: 'started', durationMs: 0, retryCount: job.attemptsMade
      });
      try {
        await processStep.execute({ command: job.data, workerId: options.workerId });
        logger.info({
          event: 'workflow_command_completed', correlationId, runId: job.data.runId, attemptId: job.data.id,
          status: 'completed', durationMs: Date.now() - startedAt, retryCount: attempt - 1
        });
      } catch (error) {
        logger.error({
          event: 'workflow_command_failed', correlationId, runId: job.data.runId, attemptId: job.data.id,
          status: 'failed', durationMs: Date.now() - startedAt, retryCount: attempt - 1,
          errorCode: 'WORKFLOW_COMMAND_FAILED'
        });
        throw error;
      }
    }, { connection: { url: options.redisUrl }, concurrency, limiter: { max: jobsPerSecond, duration: 1_000 }, lockDuration, lockRenewTime: Math.max(1_000, Math.floor(lockDuration / 3)), autorun: true });
  }
  public async close(): Promise<void> { await this.worker.pause(true); await this.worker.close(false); }
}
