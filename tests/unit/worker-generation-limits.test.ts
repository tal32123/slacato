import { describe, expect, it } from 'vitest';
import type { AgentContext, WorkflowRun } from '@slacato/core';
import {
  type ConfiguredModelGateways,
  PostgresDealBriefContextRepository,
  PostgresDealBriefWorkflowServices
} from '@slacato/infrastructure';

type ProviderRunScope = Parameters<ConfiguredModelGateways['forRun']>[0];

describe('worker generation limits', () => {
  it('does not install app-defined input or output token limits', async () => {
    let receivedScope: ProviderRunScope | undefined;
    const database = {
      sql: async () => [{ max_calls: 24, max_input_tokens: 80_000, max_output_tokens: 96_000, deadline_ms: 120_000 }]
    };
    const gateways = {
      provider: 'openrouter',
      registry: { resolve: () => ({ providerId: 'openrouter', modelId: 'free-structured-model', nativeStructuredOutput: true }) },
      async forRun(scope: ProviderRunScope) {
        receivedScope = scope;
        return { generateObject: async () => { throw new Error('Generation is outside this composition test'); } };
      }
    };
    const service = new PostgresDealBriefWorkflowServices(
      new PostgresDealBriefContextRepository(database as never),
      {} as never,
      gateways as never
    );
    const internals = service as unknown as {
      assertContextRemainsAuthorized(
        run: WorkflowRun,
        context: Readonly<Record<string, unknown>>
      ): Promise<void>;
      createAuthorizedAgentInvocation(
        run: WorkflowRun,
        context: Readonly<Record<string, unknown>>,
        invocationId: string,
        operation: string
      ): Promise<{ agentContext: AgentContext }>;
    };
    internals.assertContextRemainsAuthorized = async () => {};
    const run = {
      id: 'run_generation_limits', opportunityId: 'opportunity_generation_limits', requestedBy: 'user_generation_limits',
      status: 'specialists_running', version: 2, generationProvider: 'openrouter', generationModel: 'free-structured-model',
      startRequestHash: 'a'.repeat(64)
    } as WorkflowRun;

    const result = await internals.createAuthorizedAgentInvocation(
      run,
      {
        runId: run.id,
        account: {},
        opportunity: {},
        manifest: {},
        currentScope: {},
        manifestEntries: [],
        evidence: []
      },
      'invocation_generation_limits',
      'commercial-policy'
    );

    expect(result.agentContext.generation.limits).toMatchObject({
      maxCalls: 4,
      maxSchemaRepairs: 2,
      maxTransportRetries: 1
    });
    expect(result.agentContext.generation.limits).not.toHaveProperty('maxInputTokens');
    expect(result.agentContext.generation.limits).not.toHaveProperty('maxOutputTokens');
    expect(receivedScope?.budget).not.toHaveProperty('maxInputTokens');
    expect(receivedScope?.budget).not.toHaveProperty('maxOutputTokens');
  });
});
