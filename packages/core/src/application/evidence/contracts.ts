import type { AccessScope, AuthorizedSourceType } from '../../domain/permissions/authorize.js';
import type { CitationId } from '../../domain/shared/ids.js';

export type AuthorizedRetrievalScope = Extract<AccessScope, { allowed: true }> & Readonly<{ personaId: string }>;

export type EvidencePlan = Readonly<{
  query: string;
  fusionK: 60;
  exactLookups: readonly ['account', 'opportunity', 'contacts'];
  sectionQueries: readonly Readonly<{ section: string; query: string; sourceTypes: readonly AuthorizedSourceType[] }>[];
  sourceLimits: Readonly<Record<AuthorizedSourceType, number>>;
  mandatorySourceTypes: readonly ['policy'];
  maxContextCharacters: number;
}>;

export type RetrievalRequest = Readonly<{
  query: string;
  accountId: string;
  opportunityId: string;
  runId: string;
  scope: AuthorizedRetrievalScope;
  limit: number;
  maxContextCharacters?: number;
}>;

export type RetrievedEvidence = Readonly<{
  evidenceId: string;
  citationId: CitationId;
  content: string;
  contentHash: string;
  sourceType: AuthorizedSourceType;
  sensitivity: string;
  sourceLocator: string;
  classificationReason: string;
  policyHash: string;
  eventDate?: string | undefined;
  reliabilityClass: string;
  lexicalRank?: number | undefined;
  semanticRank?: number | undefined;
  fusionScore: number;
  reliabilityAdjustment: number;
  recencyAdjustment: number;
  score: number;
  rank: number;
}>;

export type RunEvidenceManifest = Readonly<{
  id: string;
  runId: string;
  queryHash: string;
  scopeHash: string;
  policyHash: string;
  indexProfile: string;
}>;

export type RetrievalResult = Readonly<{
  evidence: readonly RetrievedEvidence[];
  manifest: RunEvidenceManifest;
  diagnostics: Readonly<{ returned: number; contextCharacters: number; exactContextAvailable: number; missingSourceTypes: readonly AuthorizedSourceType[] }>;
}>;

export interface EvidenceRetriever {
  search(request: RetrievalRequest): Promise<RetrievalResult>;
}

export type AuthorizedCitation = Readonly<{
  citationId: CitationId;
  evidenceId: string;
  content: string;
  sourceType: AuthorizedSourceType;
  sourceLocator: string;
}>;

export type CitationResolutionRequest = Readonly<{
  manifestId: string;
  citationId: string;
  scope: AuthorizedRetrievalScope;
}>;

export interface CitationResolver {
  resolve(request: CitationResolutionRequest): Promise<AuthorizedCitation>;
}
