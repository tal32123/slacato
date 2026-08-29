import { createHash } from 'node:crypto';
import {
  CommercialAgent,
  ConversationAgent,
  StrategyAgent,
  StakeholderAgent,
  authorizeOpportunity,
  createEvidenceScopeBinding,
  dealBriefSchema,
  hashEvidenceScopeBinding,
  type AgentContext,
  type ApprovalRequirementInput,
  type CommercialArtifact,
  type ConversationArtifact,
  type DealBrief,
  type DealBriefRetrievalContext,
  type DealBriefWorkflowServices,
  type StakeholderArtifact,
  type WorkflowRun
} from '@slacato/core';
import {
  type ConfiguredModelGateways,
  PostgresDealBriefPolicyFacts
} from '@slacato/infrastructure';
import type { DealBriefContextRepository } from './postgres-deal-brief-context.repository.js';

type DurableDealBriefContext = Omit<AgentContext, 'generation'>;
type AgentOperation =
  | 'conversation-intelligence'
  | 'stakeholder-mapping'
  | 'commercial-policy'
  | 'negotiation-strategy';

/** Requires every durable field needed to construct a provider-neutral agent context. */
function requireDurableDealBriefContext(context: DealBriefRetrievalContext): DurableDealBriefContext {
  const {
    runId,
    account,
    opportunity,
    manifest,
    currentScope,
    manifestEntries,
    evidence
  } = context;
  if (
    runId === undefined
    || account === undefined
    || opportunity === undefined
    || manifest === undefined
    || currentScope === undefined
    || manifestEntries === undefined
    || evidence === undefined
  ) {
    throw new Error('Durable deal brief context is incomplete');
  }
  return { runId, account, opportunity, manifest, currentScope, manifestEntries, evidence };
}

/** Builds authorized deal context and invokes typed deal-brief agents without owning SQL or provider selection. */
export class PostgresDealBriefWorkflowServices implements DealBriefWorkflowServices {
  /** Creates the workflow adapter from explicit data-access, policy, and configured gateway collaborators. */
  public constructor(
    private readonly contextRepository: DealBriefContextRepository,
    private readonly policies: PostgresDealBriefPolicyFacts,
    private readonly gateways: ConfiguredModelGateways
  ) {}

  /** Retrieves authorized evidence and composes the durable context shared by every specialist. */
  public async retrieve(run: WorkflowRun, invocationId: string): Promise<DealBriefRetrievalContext> {
    this.assertPersistedModelMatchesConfiguration(run);
    const opportunity = await this.contextRepository.findAuthorizedOpportunity(
      run.requestedBy,
      run.opportunityId
    );
    if (opportunity === undefined) throw new Error('Authorized opportunity context is unavailable');

    const grants = await this.contextRepository.readPermissionGrants(run.requestedBy, opportunity.accountId);
    const authorization = authorizeOpportunity(
      { userId: run.requestedBy, grants },
      { accountId: opportunity.accountId, restricted: opportunity.restricted }
    );
    if (!authorization.allowed || !authorization.sourceTypes.includes('salesforce')) {
      throw new Error('Authorized opportunity context is unavailable');
    }

    const configuredEmbedding = this.gateways.registry.resolve('embedding');
    const profile = await this.contextRepository.findEmbeddingProfile(
      opportunity.accountId,
      configuredEmbedding.providerId,
      configuredEmbedding.modelId
    );
    if (profile === undefined) throw new Error('Authorized evidence index is unavailable');

    const budget = await this.contextRepository.readRunBudget(run.id);
    const logicalGenerationId = this.createStableGenerationId(run.id, 'retrieval-embedding');
    const embeddingGateway = await this.gateways.embeddingForRun({
      runScope: run.id,
      invocationId,
      logicalGenerationId,
      budget
    });
    const currentScope = { ...authorization, personaId: run.requestedBy };
    const result = await this.contextRepository.retrieveEvidence({
      query: `${opportunity.opportunityName} negotiation commercial terms stakeholders`,
      accountId: opportunity.accountId,
      opportunityId: run.opportunityId,
      runId: run.id,
      scope: currentScope,
      limit: 20,
      maxContextCharacters: 60_000
    }, embeddingGateway, profile);
    if (!result.evidence.some((record) => record.evidenceId === opportunity.stageEvidenceId)) {
      throw new Error('Canonical Salesforce opportunity stage evidence is absent from the run manifest');
    }

    const evidence = result.evidence.map((record) => ({
      ...record,
      accountId: opportunity.accountId,
      opportunityId: run.opportunityId
    }));
    const context: DurableDealBriefContext = {
      runId: run.id,
      account: { id: opportunity.accountId, name: opportunity.accountName },
      opportunity: {
        id: run.opportunityId,
        name: opportunity.opportunityName,
        stage: opportunity.stage
      },
      manifest: result.manifest,
      currentScope,
      evidence,
      manifestEntries: evidence.map((record) => ({
        manifestId: result.manifest.id,
        evidenceId: record.evidenceId,
        citationId: record.citationId,
        contentHash: record.contentHash,
        sourceLocator: record.sourceLocator,
        sourceType: record.sourceType,
        sensitivity: record.sensitivity,
        policyHash: record.policyHash,
        includedCharacters: record.content.length,
        excerptHash: createHash('sha256').update(record.content).digest('hex'),
        accountId: opportunity.accountId,
        opportunityId: run.opportunityId,
        scopeHash: result.manifest.scopeHash,
        ...(record.eventDate === undefined ? {} : { eventDate: record.eventDate })
      }))
    };
    return context;
  }

  /** Runs conversation intelligence with a freshly reauthorized agent context. */
  public async conversation(
    run: WorkflowRun,
    context: DealBriefRetrievalContext,
    invocationId: string
  ): Promise<ConversationArtifact> {
    const invocation = await this.createAuthorizedAgentInvocation(
      run,
      context,
      invocationId,
      'conversation-intelligence'
    );
    return new ConversationAgent(invocation.gateway).run(invocation.agentContext);
  }

  /** Runs stakeholder mapping with a freshly reauthorized agent context. */
  public async stakeholder(
    run: WorkflowRun,
    context: DealBriefRetrievalContext,
    invocationId: string
  ): Promise<StakeholderArtifact> {
    const invocation = await this.createAuthorizedAgentInvocation(
      run,
      context,
      invocationId,
      'stakeholder-mapping'
    );
    return new StakeholderAgent(invocation.gateway).run(invocation.agentContext);
  }

  /** Runs commercial analysis with a freshly reauthorized agent context. */
  public async commercial(
    run: WorkflowRun,
    context: DealBriefRetrievalContext,
    invocationId: string
  ): Promise<CommercialArtifact> {
    const invocation = await this.createAuthorizedAgentInvocation(
      run,
      context,
      invocationId,
      'commercial-policy'
    );
    return new CommercialAgent(invocation.gateway).run(invocation.agentContext);
  }

  /** Runs strategy synthesis from schema-validated specialist artifacts and durable context. */
  public async strategy(
    run: WorkflowRun,
    input: Readonly<{
      context: DealBriefRetrievalContext;
      conversation: ConversationArtifact;
      stakeholder: StakeholderArtifact;
      commercial: CommercialArtifact;
    }>,
    invocationId: string
  ): Promise<DealBrief> {
    const invocation = await this.createAuthorizedAgentInvocation(
      run,
      input.context,
      invocationId,
      'negotiation-strategy'
    );
    return new StrategyAgent(invocation.gateway).run(invocation.agentContext, {
      conversation: input.conversation,
      stakeholder: input.stakeholder,
      commercial: input.commercial
    });
  }

  /** Derives deterministic approval requirements from the generated brief and persisted policy facts. */
  public approvalInput(run: WorkflowRun, brief: DealBrief): Promise<ApprovalRequirementInput> {
    return this.policies.forBrief(run.opportunityId, brief);
  }

  /** Validates a generated draft against the canonical deal-brief schema. */
  public validateDraft(payload: unknown): DealBrief {
    return dealBriefSchema.parse(payload);
  }

  /** Reauthorizes durable context and attaches one run-scoped model gateway for an agent call. */
  private async createAuthorizedAgentInvocation(
    run: WorkflowRun,
    context: DealBriefRetrievalContext,
    invocationId: string,
    operation: AgentOperation
  ) {
    this.assertPersistedModelMatchesConfiguration(run);
    const durableContext = requireDurableDealBriefContext(context);
    await this.assertContextRemainsAuthorized(run, durableContext);

    const budget = await this.contextRepository.readRunBudget(run.id);
    const logicalGenerationId = this.createStableGenerationId(run.id, operation);
    const limits = {
      maxCalls: 4,
      maxSchemaRepairs: 2,
      maxTransportRetries: 1,
      deadlineMs: budget.deadlineMs
    };
    const durableAttempt = {
      runScope: run.id,
      invocationId,
      logicalGenerationId,
      provider: run.generationProvider,
      model: run.generationModel
    };
    const gateway = await this.gateways.forRun({
      runScope: run.id,
      invocationId,
      logicalGenerationId,
      budget
    });
    const agentContext: AgentContext = {
      ...durableContext,
      generation: { durableAttempt, limits }
    };
    return { gateway, agentContext };
  }

  /** Rejects durable evidence whenever its current opportunity scope or immutable manifest no longer matches. */
  private async assertContextRemainsAuthorized(
    run: WorkflowRun,
    durableContext: DurableDealBriefContext
  ): Promise<void> {
    const opportunity = await this.contextRepository.findAuthorizedOpportunity(
      run.requestedBy,
      run.opportunityId
    );
    if (
      opportunity === undefined
      || durableContext.account.id !== opportunity.accountId
      || durableContext.opportunity.id !== run.opportunityId
      || durableContext.opportunity.name !== opportunity.opportunityName
      || durableContext.opportunity.stage !== opportunity.stage
      || !durableContext.manifestEntries.some((entry) => entry.evidenceId === opportunity.stageEvidenceId)
    ) {
      throw new Error('Current opportunity authorization is unavailable');
    }

    const grants = await this.contextRepository.readPermissionGrants(run.requestedBy, opportunity.accountId);
    const authorization = authorizeOpportunity(
      { userId: run.requestedBy, grants },
      { accountId: opportunity.accountId, restricted: opportunity.restricted }
    );
    if (!authorization.allowed || !authorization.sourceTypes.includes('salesforce')) {
      throw new Error('Current opportunity authorization is unavailable');
    }

    const currentScope = { ...authorization, personaId: run.requestedBy };
    const scopeHash = hashEvidenceScopeBinding(createEvidenceScopeBinding({
      accountId: opportunity.accountId,
      opportunityId: run.opportunityId
    }, currentScope));
    const evidenceOutsideCurrentScope = durableContext.evidence.some((record) => (
      !currentScope.sourceTypes.includes(record.sourceType)
      || (
        record.sourceType === 'pricing'
        && record.sensitivity === 'sensitive'
        && !currentScope.canViewSensitivePricing
      )
      || (opportunity.restricted && !currentScope.canViewRestrictedAccounts)
    ));
    if (scopeHash !== durableContext.manifest.scopeHash || evidenceOutsideCurrentScope) {
      throw new Error('Evidence authorization changed before generation');
    }

    const manifestMatches = await this.contextRepository.manifestMatches(
      durableContext.manifest.id,
      durableContext.manifestEntries
    );
    if (!manifestMatches) {
      throw new Error('Immutable evidence manifest no longer matches generation context');
    }
  }

  /** Confirms that the persisted run uses the configured brief model identity. */
  private assertPersistedModelMatchesConfiguration(run: WorkflowRun): void {
    const configured = this.gateways.registry.resolve('brief');
    if (
      run.generationProvider !== this.gateways.provider
      || run.generationModel !== configured.modelId
    ) {
      throw new Error('Persisted run model identity does not match worker configuration');
    }
  }

  /** Derives a deterministic generation identifier from one run and operation. */
  private createStableGenerationId(runId: string, operation: string): string {
    const digest = createHash('sha256').update(`${runId}\u0000${operation}`).digest('hex');
    return `generation_${digest}`;
  }
}
