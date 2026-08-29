import type { BudgetedModelGateway } from '../model/contracts.js';
import { stakeholderArtifactSchema, type StakeholderArtifact } from '../../domain/briefs/schema.js';
import type { AgentContext, AgentEvidenceRecord } from './contracts.js';
import { runAgent } from './runtime.js';
import { validateStakeholderArtifact } from './validation.js';
import { MAX_SPECIALIST_ARTIFACT_BYTES } from '../briefs/prompts.js';
import { withSerializedByteLimit } from '../../domain/shared/serialized-size.js';

const SOURCES = new Set<AgentEvidenceRecord['sourceType']>(['salesforce', 'gong_summary', 'gong_transcript', 'slack']);
const TASK = 'Build the stakeholder map, influence assessment, relationship state, and coverage gaps. Every factual claim must cite an exact supplied citation ID. Return only the strict stakeholder artifact.';
const agentArtifactSchema = withSerializedByteLimit(stakeholderArtifactSchema, MAX_SPECIALIST_ARTIFACT_BYTES);

/** Stakeholder specialist composed over the provider-neutral budgeted gateway. */
export class StakeholderAgent {
  public constructor(private readonly gateway: BudgetedModelGateway) {}

  public async run(context: AgentContext): Promise<StakeholderArtifact> {
    const result = await runAgent({ gateway: this.gateway, context, operation: 'stakeholder-intelligence', task: TASK, schema: agentArtifactSchema, allowedSourceTypes: SOURCES });
    return agentArtifactSchema.parse(validateStakeholderArtifact(result.value, context.manifest.id, result.evidence));
  }
}
