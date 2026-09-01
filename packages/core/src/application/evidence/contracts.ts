import type { AccessScope, AuthorizedSourceType } from '../../domain/permissions/authorize.js';
import type { CitationId } from '../../domain/shared/ids.js';
import type { EvidenceScopeBinding } from './scope-binding.js';

/** Claimed request bounds plus persona identity; adapters must still enforce persisted grants. */
export type AuthorizedRetrievalScope = Extract<AccessScope, { allowed: true }> &
  Readonly<{ personaId: string }>;

/** Immutable execution recipe used to make retrieval and its query hash reproducible. */
export type EvidencePlan = Readonly<{
  query: string;
  fusionK: 60;
  exactLookups: readonly ['account', 'opportunity', 'contacts'];
  sectionQueries: readonly Readonly<{
    section: string;
    query: string;
    sourceTypes: readonly AuthorizedSourceType[];
  }>[];
  /** Share of fused mass one section query may contribute, relative to the caller's own query.
   *  Part of the plan (and therefore of the hashed retrieval recipe) because it changes ranking. */
  sectionQueryWeight: number;
  sourceLimits: Readonly<Record<AuthorizedSourceType, number>>;
  /** Always-surface guarantee for canonical CRM records (account, opportunity, every contact);
   *  distinct from `sourceLimits.salesforce`, which bounds the hybrid-search candidate window. */
  crmRecordLimit: number;
  mandatorySourceTypes: readonly ['policy'];
  policyReservation: Readonly<{ resultSlots: 1; contextCharacters: number }>;
  maxContextCharacters: number;
}>;

/** Complete authorized retrieval request bound to an already-persisted workflow run. */
export type RetrievalRequest = Readonly<{
  query: string;
  accountId: string;
  opportunityId: string;
  runId: string;
  scope: AuthorizedRetrievalScope;
  limit: number;
  maxContextCharacters?: number;
}>;

/** Bounded evidence excerpt plus immutable provenance and transparent ranking details. */
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

/** Stable identity of the immutable evidence snapshot consumed by a run. */
export type RunEvidenceManifest = Readonly<{
  id: string;
  runId: string;
  queryHash: string;
  scopeHash: string;
  policyHash: string;
  indexProfile: string;
  binding: EvidenceScopeBinding;
}>;

/** Authorized structured-row counts used to distinguish exact context from ranked excerpts. */
export type ExactLookupDiagnostics = Readonly<{
  account: number;
  opportunity: number;
  contacts: number;
}>;
/** Explicit policy outcome prevents a mandatory source from disappearing behind a context limit. */
export type MandatoryPolicyDiagnostic = 'included' | 'missing' | 'not_evaluated';

/** Safe diagnostics contain authorized counts only and are empty for opaque denials. */
export type RetrievalResult = Readonly<{
  evidence: readonly RetrievedEvidence[];
  manifest: RunEvidenceManifest;
  diagnostics: Readonly<{
    returned: number;
    contextCharacters: number;
    exactContextAvailable: number;
    exactLookups: ExactLookupDiagnostics;
    sectionMatches: Readonly<Record<string, number>>;
    mandatoryPolicy: MandatoryPolicyDiagnostic;
    truncatedEvidenceIds: readonly string[];
    missingSourceTypes: readonly AuthorizedSourceType[];
  }>;
}>;

/** Deep retrieval port; implementations must authorize inside every candidate query before ranking. */
export interface EvidenceRetriever {
  search(request: RetrievalRequest): Promise<RetrievalResult>;
}

/** Reauthorized citation payload; source existence is never observable on denial. */
export type AuthorizedCitation = Readonly<{
  citationId: CitationId;
  evidenceId: string;
  content: string;
  sourceType: AuthorizedSourceType;
  sourceLocator: string;
}>;

/** Citation resolution request scoped to one immutable run manifest. */
export type CitationResolutionRequest = Readonly<{
  manifestId: string;
  citationId: string;
  scope: AuthorizedRetrievalScope;
}>;

/** Defense-in-depth port resolving only current, authorized, in-manifest citations. */
export interface CitationResolver {
  resolve(request: CitationResolutionRequest): Promise<AuthorizedCitation>;
}
