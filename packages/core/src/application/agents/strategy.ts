import { type DealBrief, dealBriefSchema } from '../../domain/briefs/schema.js';
import type { BudgetedModelGateway } from '../model/contracts.js';
import {
  type AgentContext,
  type AgentEvidenceRecord,
  dealBriefAgentOperations,
  type StrategyArtifacts
} from './contracts.js';
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
  'Build the strict nine-section DealBrief from the three validated artifacts and manifest. Every factual claim must cite a manifest record, including evidence no specialist retained. Use unique claim_<suffix> ids across all sections and never reuse artifact ids. Warning codes are UPPERCASE_WITH_UNDERSCORES and name only brief claims. Each claim statement copies one complete source sentence or line, never a whole record. Make every narrative, goal, driver, negotiation item, action rationale, and source summary equal one supporting claim statement. Set positive overallConfidence when claims survive and fill every supported section. For each stakeholder mint one fresh claim naming the person in full and restating their title exactly as the cited record states it, without naming the company. For each action mint one fresh claim grounding its rationale; copy that statement into the rationale. Set required audience to internal for deal-team-only work or customer for buyer-side communication, delivery, or coordination; downstream policy must not infer audience from wording. Write each action as one bounded instruction without a causal clause. Give every cited manifest record its own sourceEvidence entry, plus each remaining supporting Slack update, pricing note, and policy. Each entry needs a fresh claim quoting one source sentence, the same summary, and sourceType salesforce=crm, gong=conversation, otherwise policy, pricing, or slack. Warn only about reviewer action. Return only DealBrief.';

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
      operation: dealBriefAgentOperations.strategy,
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
