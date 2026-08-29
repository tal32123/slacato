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

import type { RunEvidenceManifest, RetrievedEvidence } from '../evidence/contracts.js';
import type { RetryLimits, SharedRunBudget } from '../model/contracts.js';
import type { ProviderAttemptContext } from '../model/provider-attempt-ledger.js';

/** Evidence exposed to an agent is explicitly bound to its authorized deal target. */
export type AgentEvidenceRecord = RetrievedEvidence & Readonly<{
  accountId: string;
  opportunityId: string;
}>;

/** Exact persisted manifest-entry fingerprint used to reject free-standing evidence records. */
export type AgentManifestEntry = Readonly<Pick<AgentEvidenceRecord,
  'evidenceId' | 'citationId' | 'contentHash' | 'sourceLocator' | 'sourceType' | 'sensitivity' | 'policyHash'> & {
    manifestId: string;
    includedCharacters: number;
    excerptHash: string;
    eventDate?: string | undefined;
  }>;

/** Provider-neutral generation controls supplied by the durable workflow composition root. */
export type AgentGenerationContext = Readonly<{
  durableAttempt: ProviderAttemptContext;
  limits: RetryLimits;
  budget?: SharedRunBudget;
}>;

/**
 * Immutable input shared by specialists. It deliberately exposes no repository,
 * tool, transport, or other-agent capability.
 */
export type AgentContext = Readonly<{
  runId: string;
  account: Readonly<{ id: string; name: string }>;
  opportunity: Readonly<{ id: string; name: string; stage: string }>;
  manifest: RunEvidenceManifest;
  manifestEntries: readonly AgentManifestEntry[];
  evidence: readonly AgentEvidenceRecord[];
  generation: AgentGenerationContext;
}>;

/** Validated specialist fan-in accepted by negotiation strategy. */
export type StrategyArtifacts = Readonly<{
  conversation: import('../../domain/briefs/schema.js').ConversationArtifact;
  stakeholder: import('../../domain/briefs/schema.js').StakeholderArtifact;
  commercial: import('../../domain/briefs/schema.js').CommercialArtifact;
}>;
