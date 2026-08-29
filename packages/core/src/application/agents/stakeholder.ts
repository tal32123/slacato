import type { BudgetedModelGateway } from '../model/contracts.js';
import { stakeholderArtifactSchema, type StakeholderArtifact } from '../../domain/briefs/schema.js';
import type { AgentContext, AgentEvidenceRecord } from './contracts.js';
import { runAgent } from './runtime.js';
import { validateStakeholderArtifact } from './validation.js';
import { MAX_SPECIALIST_ARTIFACT_BYTES } from '../briefs/prompts.js';
import { withSerializedByteLimit } from '../../domain/shared/serialized-size.js';

const SOURCES = new Set<AgentEvidenceRecord['sourceType']>(['salesforce', 'gong_summary', 'gong_transcript', 'slack']);
const TASK = 'Build the stakeholder map, influence assessment, relationship state, and coverage gaps. Every factual claim must copy one complete supplied citation tuple without changing any of its three fields. Return only the strict stakeholder artifact.';
const agentArtifactSchema = withSerializedByteLimit(stakeholderArtifactSchema, MAX_SPECIALIST_ARTIFACT_BYTES);

/** Maps the people influencing a deal, their relationships, and any coverage gaps. */
export class StakeholderAgent {
  /** Creates the stakeholder analyst with the model gateway used to generate its assessment. */
  public constructor(private readonly gateway: BudgetedModelGateway) {}

  /** Produces a validated stakeholder assessment from the evidence authorized for a deal. */
  public async run(context: AgentContext): Promise<StakeholderArtifact> {
    const result = await runAgent({
      gateway: this.gateway, context, operation: 'stakeholder-intelligence', task: TASK,
      schema: agentArtifactSchema, allowedSourceTypes: SOURCES,
      validate: (value, evidence) => validateStakeholderArtifact(value, context.manifest.id, evidence)
    });
    return agentArtifactSchema.parse(result.value);
  }
}
