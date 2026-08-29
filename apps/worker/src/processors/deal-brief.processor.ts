import { createHash } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import {
  CommercialAgent, ConversationAgent, StrategyAgent, StakeholderAgent, authorizeOpportunity, dealBriefSchema,
  type AgentContext, type ApprovalRequirementInput, type DealBrief, type DealBriefWorkflowServices,
  type PermissionGrant, type StrategyArtifacts, type WorkflowCommand, type WorkflowRun, ProcessDealBriefStep
} from '@slacato/core';
import {
  PostgresDealBriefPolicyFacts, PostgresHybridEvidenceRetriever, WORKFLOW_QUEUE_NAME,
  type ConfiguredModelGateways, type DatabaseClient
} from '@slacato/infrastructure';
type DurableContext = Omit<AgentContext, 'generation'>;
type OpportunityRow = Readonly<{ account_id: string; account_name: string; opportunity_name: string; stage: string; restricted: boolean }>;
type BudgetRow = Readonly<{ max_calls: number; max_input_tokens: number; max_output_tokens: number; deadline_ms: number }>;

/** Production workflow services reconstruct authorized context and a run-scoped gateway for every generation. */
export class PostgresDealBriefWorkflowServices implements DealBriefWorkflowServices {
  private readonly policies: PostgresDealBriefPolicyFacts;
  public constructor(private readonly database: DatabaseClient, private readonly gateways: ConfiguredModelGateways) {
    this.policies = new PostgresDealBriefPolicyFacts(database);
  }

  public async retrieve(run: WorkflowRun): Promise<Readonly<Record<string, unknown>>> {
    const opportunity = (await this.database.sql<OpportunityRow[]>`select opportunity.account_id, account.name account_name,
      opportunity.name opportunity_name, opportunity.stage, opportunity.restricted from opportunities opportunity
      join accounts account on account.id = opportunity.account_id where opportunity.id = ${run.opportunityId}`)[0];
    if (opportunity === undefined) throw new Error('Authorized opportunity context is unavailable');
    const grants = await this.database.sql<Array<{ accountId: string; source_type: PermissionGrant['sourceType']; canRead: boolean; canReadRestricted: boolean; canRequestApproval: boolean; canApprove: boolean; sensitivePricing: boolean }>>`select account_id "accountId", source_type,
      can_read "canRead", can_read_restricted "canReadRestricted", can_request_approval "canRequestApproval", can_approve "canApprove", sensitive_pricing "sensitivePricing"
      from permission_grants where persona_id = ${run.requestedBy} and account_id = ${opportunity.account_id}`;
    const normalized: PermissionGrant[] = grants.map(({ source_type, ...grant }) => ({ ...grant, sourceType: source_type }));
    const authorized = authorizeOpportunity({ userId: run.requestedBy, grants: normalized }, { accountId: opportunity.account_id, restricted: opportunity.restricted });
    if (!authorized.allowed) throw new Error('Authorized opportunity context is unavailable');
    const profile = (await this.database.sql<{ provider: string; model: string; dimension: number; profile: string; version: string; normalization: string }[]>`select embedding_provider provider, embedding_model model, embedding_dimension dimension,
      embedding_profile profile, embedding_version version, embedding_normalization normalization from evidence_versions
      where embedding is not null and account_id = ${opportunity.account_id} order by created_at desc limit 1`)[0];
    if (profile === undefined) throw new Error('Authorized evidence index is unavailable');
    const currentScope = { ...authorized, personaId: run.requestedBy };
    const result = await new PostgresHybridEvidenceRetriever(this.database, this.gateways.embeddingGateway, profile).search({
      query: `${opportunity.opportunity_name} negotiation commercial terms stakeholders`, accountId: opportunity.account_id,
      opportunityId: run.opportunityId, runId: run.id, scope: currentScope, limit: 20, maxContextCharacters: 60_000
    });
    const evidence = result.evidence.map((record) => ({ ...record, accountId: opportunity.account_id, opportunityId: run.opportunityId }));
    const context: DurableContext = {
      runId: run.id,
      account: { id: opportunity.account_id, name: opportunity.account_name },
      opportunity: { id: run.opportunityId, name: opportunity.opportunity_name, stage: opportunity.stage },
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
    return context as unknown as Readonly<Record<string, unknown>>;
  }

  public async conversation(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string) {
    const { agentContext, gateway } = await this.agentContext(run, context, invocationId, 'conversation-intelligence');
    return new ConversationAgent(gateway).run(agentContext) as unknown as Promise<Readonly<Record<string, unknown>>>;
  }
  public async stakeholder(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string) {
    const { agentContext, gateway } = await this.agentContext(run, context, invocationId, 'stakeholder-mapping');
    return new StakeholderAgent(gateway).run(agentContext) as unknown as Promise<Readonly<Record<string, unknown>>>;
  }
  public async commercial(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string) {
    const { agentContext, gateway } = await this.agentContext(run, context, invocationId, 'commercial-policy');
    return new CommercialAgent(gateway).run(agentContext) as unknown as Promise<Readonly<Record<string, unknown>>>;
  }
  public async strategy(run: WorkflowRun, input: Readonly<{ context: Readonly<Record<string, unknown>>; conversation: Readonly<Record<string, unknown>>; stakeholder: Readonly<Record<string, unknown>>; commercial: Readonly<Record<string, unknown>> }>, invocationId: string): Promise<DealBrief> {
    const { agentContext, gateway } = await this.agentContext(run, input.context, invocationId, 'negotiation-strategy');
    return new StrategyAgent(gateway).run(agentContext, {
      conversation: input.conversation, stakeholder: input.stakeholder, commercial: input.commercial
    } as unknown as StrategyArtifacts);
  }
  public approvalInput(run: WorkflowRun, brief: DealBrief): Promise<ApprovalRequirementInput> { return this.policies.forBrief(run.opportunityId, brief); }
  public validateDraft(payload: unknown): DealBrief { return dealBriefSchema.parse(payload); }

  private async agentContext(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string, operation: string) {
    const budget = (await this.database.sql<BudgetRow[]>`select max_calls, max_input_tokens, max_output_tokens, deadline_ms from run_budgets where run_id = ${run.id}`)[0];
    if (budget === undefined) throw new Error('Run budget is unavailable');
    const logicalGenerationId = `generation_${createHash('sha256').update(`${run.id}\u0000${operation}`).digest('hex')}`;
    const limits = { maxCalls: 3, maxSchemaRepairs: 1, maxTransportRetries: 1, deadlineMs: budget.deadline_ms, maxInputTokens: budget.max_input_tokens, maxOutputTokens: budget.max_output_tokens };
    const durableAttempt = { runScope: run.id, invocationId, logicalGenerationId, provider: run.generationProvider, model: run.generationModel };
    const gateway = await this.gateways.forRun({ runScope: run.id, invocationId, logicalGenerationId, budget: { scope: run.id, maxCalls: budget.max_calls, maxInputTokens: budget.max_input_tokens, maxOutputTokens: budget.max_output_tokens, deadlineMs: budget.deadline_ms } });
    return { gateway, agentContext: { ...(context as unknown as DurableContext), generation: { durableAttempt, limits } } satisfies AgentContext };
  }
}

export type DealBriefProcessorOptions = Readonly<{
  redisUrl: string;
  workerId: string;
  concurrency?: number;
  jobsPerSecond?: number;
  lockDurationMs?: number;
}>;

/** Thin BullMQ delivery adapter. Model retry policy remains exclusively inside BudgetedModelGateway. */
export class DealBriefProcessor {
  private readonly worker: Worker<WorkflowCommand, void, 'workflow-command'>;
  public constructor(processStep: ProcessDealBriefStep, options: DealBriefProcessorOptions) {
    const concurrency = options.concurrency ?? 1;
    const jobsPerSecond = options.jobsPerSecond ?? 2;
    const lockDuration = options.lockDurationMs ?? 120_000;
    if (!Number.isInteger(concurrency) || concurrency !== 1) throw new RangeError('Initial deal brief worker concurrency must be exactly one');
    if (!Number.isInteger(jobsPerSecond) || jobsPerSecond < 1) throw new RangeError('Worker rate limit must be positive');
    this.worker = new Worker<WorkflowCommand, void, 'workflow-command'>(WORKFLOW_QUEUE_NAME, async (job: Job<WorkflowCommand, void, 'workflow-command'>) => {
      await processStep.execute({ command: job.data, workerId: options.workerId });
    }, {
      connection: { url: options.redisUrl }, concurrency, limiter: { max: jobsPerSecond, duration: 1_000 },
      lockDuration, lockRenewTime: Math.max(1_000, Math.floor(lockDuration / 3)), autorun: true
    });
  }
  public async close(): Promise<void> { await this.worker.pause(true); await this.worker.close(false); }
}
