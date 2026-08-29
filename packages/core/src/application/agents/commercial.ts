import { type CommercialArtifact, commercialArtifactSchema } from '../../domain/briefs/schema.js';
import { withSerializedByteLimit } from '../../domain/shared/serialized-size.js';
import { MAX_SPECIALIST_ARTIFACT_BYTES } from '../briefs/prompts.js';
import type { BudgetedModelGateway } from '../model/contracts.js';
import type { AgentContext, AgentEvidenceRecord } from './contracts.js';
import { runAgent } from './runtime.js';
import { validateCommercialArtifact } from './validation.js';

const SOURCES = new Set<AgentEvidenceRecord['sourceType']>(['salesforce', 'pricing', 'policy']);
const TASK =
  'Analyze commercial terms, pricing state, deterministic policy triggers, and approvals that may be required. Policy evidence outranks model inference. Every factual claim must copy one complete supplied citation tuple without changing any of its three fields. Return only the strict commercial artifact.';
const agentArtifactSchema = withSerializedByteLimit(
  commercialArtifactSchema,
  MAX_SPECIALIST_ARTIFACT_BYTES
);

/** Analyzes pricing, commercial terms, policy triggers, and approval needs for a deal. */
export class CommercialAgent {
  /** Creates the commercial analyst with the model gateway used to generate its assessment. */
  public constructor(private readonly gateway: BudgetedModelGateway) {}

  /** Produces a validated commercial assessment from the evidence authorized for a deal. */
  public async run(context: AgentContext): Promise<CommercialArtifact> {
    const result = await runAgent({
      gateway: this.gateway,
      context,
      operation: 'commercial-policy-analysis',
      task: TASK,
      schema: agentArtifactSchema,
      allowedSourceTypes: SOURCES,
      validate: (value, evidence) =>
        validateCommercialArtifact(value, context.manifest.id, evidence)
    });
    return agentArtifactSchema.parse(result.value);
  }
}
