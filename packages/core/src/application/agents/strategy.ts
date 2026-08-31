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
  'Synthesize the three validated specialist artifacts and the authorized manifest into the canonical nine-section deal brief. Every factual claim must cite a manifest record, including evidence no specialist retained. Claim ids use the claim_<unique_suffix> format, stay unique across every section, stakeholder, action and source entry, and never reuse an artifact id. Warning codes are UPPERCASE_WITH_UNDERSCORES naming only claims in this brief. Copy one complete sentence or one line of a record into each claim statement, never a whole record, and make every narrative, goal, business driver, negotiation item, action rationale and source summary exactly equal to one supporting claim statement. Set overallConfidence above zero whenever supported claims survive, and fill every section the manifest supports instead of leaving placeholders. For each stakeholder mint one fresh claim naming the person in full and restating their title exactly as the cited record states it, without naming the company. For each action mint one fresh claim grounding its rationale, copy that statement into the rationale, and write the action as one internal instruction opening on a bounded verb such as schedule, prepare, confirm or verify, with no causal clause. Give every manifest record cited anywhere in this brief its own sourceEvidence entry, and add one for each remaining record that supports the deal, including the Slack account-team updates, the pricing notes and the deal desk policy. Each entry needs one fresh claim quoting one sentence of its record, that sentence as the summary, and sourceType from the record: crm for salesforce, conversation for gong, else policy, pricing or slack. Warn only about what a reviewer must act on. Return only the strict DealBrief.';

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
