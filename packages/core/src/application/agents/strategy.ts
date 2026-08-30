import { type DealBrief, dealBriefSchema } from '../../domain/briefs/schema.js';
import type { BudgetedModelGateway } from '../model/contracts.js';
import type { AgentContext, AgentEvidenceRecord, StrategyArtifacts } from './contracts.js';
import { runAgent } from './runtime.js';
import {
  validateCommercialArtifact,
  validateConversationArtifact,
  validateDealBrief,
  validateStakeholderArtifact
} from './validation.js';

const ALL_SOURCES = new Set<AgentEvidenceRecord['sourceType']>([
  'gong_summary',
  'gong_transcript',
  'policy',
  'pricing',
  'salesforce',
  'slack'
]);
const TASK =
  'Synthesize the three validated specialist artifacts and the complete authorized evidence manifest into the canonical nine-section deal brief. Every factual claim must cite an authorized manifest record, including evidence not retained by a specialist when it directly supports the section. Every claim id must use the exact claim_<unique_suffix> format, be globally unique across all sections, nested stakeholders, actions, and source evidence, and never reuse an artifact claim id or an id from another section. Every review-warning code must be uppercase with underscores, and every review-warning claim id must name a claim emitted in the final brief. Ground section text conservatively: copy a complete evidence sentence into the claim statement, then make each narrative, goal, business driver, negotiation-state item, action rationale, and source summary exactly equal to one supporting claim statement instead of paraphrasing it. Set overallConfidence above zero whenever supported claims survive validation. When the manifest contains relevant evidence, provide grounded buyer goals, stakeholders, negotiation state, concrete safe next actions, missing information, and source summaries instead of empty placeholders. Return only the strict DealBrief.';

/** Combines validated specialist findings into the deal team’s negotiation brief. */
export class StrategyAgent {
  /** Creates the strategy analyst with the model gateway used to generate the brief. */
  public constructor(private readonly gateway: BudgetedModelGateway) {}

  /** Produces a support-checked deal brief from validated specialist assessments. */
  public async run(context: AgentContext, artifacts: StrategyArtifacts): Promise<DealBrief> {
    const conversation = validateConversationArtifact(
      artifacts.conversation,
      context.manifest.id,
      context.evidence
    );
    const stakeholder = validateStakeholderArtifact(
      artifacts.stakeholder,
      context.manifest.id,
      context.evidence
    );
    const commercial = validateCommercialArtifact(
      artifacts.commercial,
      context.manifest.id,
      context.evidence
    );
    const result = await runAgent({
      gateway: this.gateway,
      context,
      operation: 'negotiation-strategy',
      task: TASK,
      schema: dealBriefSchema,
      allowedSourceTypes: ALL_SOURCES,
      artifacts: [
        { id: 'conversation', value: conversation },
        { id: 'stakeholder', value: stakeholder },
        { id: 'commercial', value: commercial }
      ],
      validate: (value, evidence) => validateDealBrief(value, evidence, context)
    });
    return dealBriefSchema.parse(result.value);
  }
}
