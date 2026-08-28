/**
 * Shared agent-output contracts. Agents only exchange these immutable,
 * schema-validated artifacts; provider and persistence details stay outside core.
 */
export {
  commercialArtifactSchema,
  conversationArtifactSchema,
  stakeholderArtifactSchema,
  strategyArtifactSchema
} from '../../domain/briefs/schema.js';

export type {
  CommercialArtifact,
  ConversationArtifact,
  StakeholderArtifact,
  StrategyArtifact
} from '../../domain/briefs/schema.js';
