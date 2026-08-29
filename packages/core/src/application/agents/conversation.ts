import type { BudgetedModelGateway } from '../model/contracts.js';
import { conversationArtifactSchema, type ConversationArtifact } from '../../domain/briefs/schema.js';
import type { AgentContext, AgentEvidenceRecord } from './contracts.js';
import { runAgent } from './runtime.js';
import { validateConversationArtifact } from './validation.js';
import { MAX_SPECIALIST_ARTIFACT_BYTES } from '../briefs/prompts.js';
import { withSerializedByteLimit } from '../../domain/shared/serialized-size.js';

const SOURCES = new Set<AgentEvidenceRecord['sourceType']>(['gong_summary', 'gong_transcript', 'slack']);
const TASK = 'Extract buyer goals, concerns, commitments, objections, and missing context. Every factual claim must cite an exact supplied citation ID. Return only the strict conversation artifact.';
const agentArtifactSchema = withSerializedByteLimit(conversationArtifactSchema, MAX_SPECIALIST_ARTIFACT_BYTES);

/** Conversation specialist composed over the provider-neutral budgeted gateway. */
export class ConversationAgent {
  public constructor(private readonly gateway: BudgetedModelGateway) {}

  public async run(context: AgentContext): Promise<ConversationArtifact> {
    const result = await runAgent({
      gateway: this.gateway, context, operation: 'conversation-intelligence', task: TASK,
      schema: agentArtifactSchema, allowedSourceTypes: SOURCES,
      validate: (value, evidence) => validateConversationArtifact(value, context.manifest.id, evidence)
    });
    return agentArtifactSchema.parse(result.value);
  }
}
