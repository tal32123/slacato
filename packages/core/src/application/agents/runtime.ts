import { z } from 'zod';
import type { BudgetedModelGateway } from '../model/contracts.js';
import { buildAgentPrompt, pruneAgentEvidence } from '../briefs/prompts.js';
import type { AgentContext, AgentEvidenceRecord } from './contracts.js';
import { assertAgentContextBindings } from './validation.js';
import { DomainValidationError } from '../../domain/shared/errors.js';

export async function runAgent<Value>(input: Readonly<{
  gateway: BudgetedModelGateway;
  context: AgentContext;
  operation: string;
  task: string;
  schema: z.ZodType<Value>;
  allowedSourceTypes: ReadonlySet<AgentEvidenceRecord['sourceType']>;
  artifacts?: readonly Readonly<{ id: string; value: unknown }>[];
  citedIds?: ReadonlySet<string>;
  validate?: (value: Value, evidence: readonly AgentEvidenceRecord[]) => Value;
}>): Promise<Readonly<{ value: Value; evidence: readonly AgentEvidenceRecord[] }>> {
  assertAgentContextBindings(input.context);
  const evidence = pruneAgentEvidence(input.context.evidence, input.allowedSourceTypes, input.citedIds);
  const prompt = buildAgentPrompt({
    task: input.task,
    trustedContext: {
      runId: input.context.runId,
      manifestId: input.context.manifest.id,
      accountId: input.context.account.id,
      accountName: input.context.account.name,
      opportunityId: input.context.opportunity.id,
      opportunityName: input.context.opportunity.name,
      opportunityStage: input.context.opportunity.stage
    },
    evidence,
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts })
  });
  const schema = input.validate === undefined ? input.schema : input.schema.transform((value, issueContext) => {
    try {
      return input.validate?.(value, evidence) ?? value;
    } catch (error) {
      if (!(error instanceof DomainValidationError)) throw error;
      const details = Object.keys(error.details).length === 0 ? '' : ` Details: ${JSON.stringify(error.details)}`;
      issueContext.addIssue({ code: 'custom', message: `${error.message}${details}` });
      return z.NEVER;
    }
  });
  const generation = await input.gateway.generateObject({
    schema,
    messages: prompt.messages,
    operation: input.operation,
    limits: input.context.generation.limits,
    durableAttempt: input.context.generation.durableAttempt,
    ...(input.context.generation.budget === undefined ? {} : { budget: input.context.generation.budget }),
    context: {
      instructions: prompt.instructions,
      currentTask: prompt.currentTask,
      evidence: [...prompt.evidence, ...prompt.artifacts]
    }
  });
  return { value: generation.value, evidence: prompt.evidenceRecords };
}
