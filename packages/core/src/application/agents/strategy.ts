import { type DealBrief, dealBriefSchema } from '../../domain/briefs/schema.js';
import type { BudgetedModelGateway } from '../model/contracts.js';
import type { AgentContext, AgentEvidenceRecord, StrategyArtifacts } from './contracts.js';
import { runAgent } from './runtime.js';
import {
  collectArtifactCitationEvidenceIds,
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
  'Synthesize the three validated specialist artifacts into the canonical nine-section deal brief. Use only citations already present in the validated artifacts. Prioritize negotiation state, concrete next actions, missing information, confidence, and review warnings. Return only the strict DealBrief.';

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
    const validatedArtifacts: StrategyArtifacts = { conversation, stakeholder, commercial };
    const citedIds = collectArtifactCitationEvidenceIds(validatedArtifacts);
    const citedContext: AgentContext = {
      ...context,
      evidence: context.evidence.filter((record) => citedIds.has(record.evidenceId)),
      manifestEntries: context.manifestEntries.filter((entry) => citedIds.has(entry.evidenceId))
    };
    const result = await runAgent({
      gateway: this.gateway,
      context: citedContext,
      operation: 'negotiation-strategy',
      task: TASK,
      schema: dealBriefSchema,
      allowedSourceTypes: ALL_SOURCES,
      citedIds,
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
