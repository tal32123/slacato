import type { BudgetedModelGateway } from '../model/contracts.js';
import { commercialArtifactSchema, type CommercialArtifact } from '../../domain/briefs/schema.js';
import type { AgentContext, AgentEvidenceRecord } from './contracts.js';
import { runAgent } from './runtime.js';
import { validateCommercialArtifact } from './validation.js';
import { MAX_SPECIALIST_ARTIFACT_BYTES } from '../briefs/prompts.js';
import { withSerializedByteLimit } from '../../domain/shared/serialized-size.js';

const SOURCES = new Set<AgentEvidenceRecord['sourceType']>(['salesforce', 'pricing', 'policy']);
const TASK = 'Analyze commercial terms, pricing state, deterministic policy triggers, and approvals that may be required. Policy evidence outranks model inference. Every factual claim must cite an exact supplied citation ID. Return only the strict commercial artifact.';
const agentArtifactSchema = withSerializedByteLimit(commercialArtifactSchema, MAX_SPECIALIST_ARTIFACT_BYTES);

/** Commercial-and-policy specialist composed over the provider-neutral budgeted gateway. */
export class CommercialAgent {
  public constructor(private readonly gateway: BudgetedModelGateway) {}

  public async run(context: AgentContext): Promise<CommercialArtifact> {
    const result = await runAgent({
      gateway: this.gateway, context, operation: 'commercial-policy-analysis', task: TASK,
      schema: agentArtifactSchema, allowedSourceTypes: SOURCES,
      validate: (value, evidence) => validateCommercialArtifact(value, context.manifest.id, evidence)
    });
    return agentArtifactSchema.parse(result.value);
  }
}
