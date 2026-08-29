import { describe, expect, it } from 'vitest';
import type { AgentContext, WorkflowRun } from '@slacato/core';
import type { ProviderRunScope } from '../../packages/infrastructure/src/model/provider.js';
import { PostgresDealBriefWorkflowServices } from '../../apps/worker/src/processors/postgres-deal-brief-workflow-services.js';

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
    const service = new PostgresDealBriefWorkflowServices(database as never, gateways as never);
    const internals = service as unknown as {
      reauthorizeContext(run: WorkflowRun, context: Readonly<Record<string, unknown>>): Promise<void>;
      agentContext(run: WorkflowRun, context: Readonly<Record<string, unknown>>, invocationId: string, operation: string): Promise<{ agentContext: AgentContext }>;
    };
    internals.reauthorizeContext = async () => {};
    const run = {
      id: 'run_generation_limits', opportunityId: 'opportunity_generation_limits', requestedBy: 'user_generation_limits',
      status: 'specialists_running', version: 2, generationProvider: 'openrouter', generationModel: 'free-structured-model',
      startRequestHash: 'a'.repeat(64)
    } as WorkflowRun;

    const result = await internals.agentContext(run, {}, 'invocation_generation_limits', 'commercial-policy');

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
