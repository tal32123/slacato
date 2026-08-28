import { z } from 'zod';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- required for declaration emission of branded IDs.
import type { $brand } from 'zod/v4/core';
import { citationIdSchema, claimIdSchema, evidenceIdSchema } from '../shared/ids.js';
import { immutableSchema } from '../shared/readonly.js';
import { MAX_SERIALIZED_ARTIFACT_BYTES, withSerializedByteLimit } from '../shared/serialized-size.js';

/** Maximum length for a generated label, summary, warning, or other short text field. */
export const MAX_SHORT_TEXT_LENGTH = 2_000;
/** Maximum length for a generated narrative section, which protects context and export budgets. */
export const MAX_SECTION_TEXT_LENGTH = 8_000;
/** Maximum entries in a generated list, preventing unbounded specialist or brief fan-in. */
export const MAX_LIST_ITEMS = 50;
/** Maximum evidence links per claim, enough for support without unbounded citation fan-out. */
export const MAX_CITATIONS_PER_CLAIM = 10;
/** Maximum ISO timestamp length, allowing precision while preventing unbounded fractional seconds. */
export const MAX_TIMESTAMP_LENGTH = 64;

const shortTextSchema = z.string().min(1).max(MAX_SHORT_TEXT_LENGTH);
const sectionTextSchema = z.string().min(1).max(MAX_SECTION_TEXT_LENGTH);
const dateSchema = z.string().max(10).regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date');
const evidenceManifestIdSchema = z.string().min(1).max(128).regex(/^manifest_[A-Za-z0-9][A-Za-z0-9_-]*$/);

/** Stable, bounded reference from a claim to an immutable authorized evidence version. */
export const citationSchema = immutableSchema(z.object({
  id: citationIdSchema,
  evidenceId: evidenceIdSchema,
  locator: shortTextSchema,
  rationale: shortTextSchema.optional()
}).strict());

/** A generated statement whose confidence and evidence links remain inspectable. */
export const claimSchema = immutableSchema(z.object({
  id: claimIdSchema,
  statement: shortTextSchema,
  confidence: z.number().finite().min(0).max(1),
  citations: z.array(citationSchema).max(MAX_CITATIONS_PER_CLAIM)
}).strict());

/** A review warning that keeps unsupported or contradictory output explicit. */
export const reviewWarningSchema = immutableSchema(z.object({
  code: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/),
  severity: z.enum(['info', 'warning', 'critical']),
  message: shortTextSchema,
  claimIds: z.array(claimIdSchema).max(MAX_LIST_ITEMS)
}).strict());

/** Named stakeholder with bounded relationship and influence context. */
export const stakeholderSchema = immutableSchema(z.object({
  name: shortTextSchema,
  title: shortTextSchema.optional(),
  organization: shortTextSchema.optional(),
  role: z.enum(['economic_buyer', 'champion', 'decision_maker', 'evaluator', 'influencer', 'legal', 'procurement', 'unknown']),
  influence: z.enum(['low', 'medium', 'high']),
  relationship: z.enum(['unknown', 'negative', 'neutral', 'positive']),
  goals: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  concerns: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS)
}).strict());

/** Prioritized concrete action recommended for the deal team. */
export const recommendedActionSchema = immutableSchema(z.object({
  action: shortTextSchema,
  owner: shortTextSchema.optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  rationale: shortTextSchema,
  dueDate: dateSchema.optional(),
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS)
}).strict());

/** Authorized source evidence summarized without copying unbounded source text. */
export const evidenceSummarySchema = immutableSchema(z.object({
  evidenceId: evidenceIdSchema,
  sourceType: z.enum(['crm', 'conversation', 'policy', 'pricing', 'slack', 'other']),
  summary: shortTextSchema,
  capturedAt: z.string().datetime().max(MAX_TIMESTAMP_LENGTH),
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS)
}).strict());

const dealSnapshotSchema = z.object({
  accountName: shortTextSchema,
  opportunityName: shortTextSchema,
  stage: shortTextSchema,
  closeDate: dateSchema.optional(),
  amount: z.number().finite().nonnegative().optional(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),
  owner: shortTextSchema.optional(),
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS).optional()
}).strict();

const executiveSummarySchema = z.object({
  narrative: sectionTextSchema,
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS).optional()
}).strict();

const buyerGoalsAndBusinessDriversSchema = z.object({
  goals: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  businessDrivers: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS).optional()
}).strict();

const stakeholderMapSchema = z.object({
  stakeholders: z.array(stakeholderSchema).max(MAX_LIST_ITEMS),
  coverageGaps: z.array(shortTextSchema).max(MAX_LIST_ITEMS).optional(),
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS).optional()
}).strict();

const negotiationStateSchema = z.object({
  currentState: sectionTextSchema,
  leverage: z.array(shortTextSchema).max(MAX_LIST_ITEMS).optional(),
  risks: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS).optional()
}).strict();

const recommendedNextActionsSchema = z.object({
  actions: z.array(recommendedActionSchema).max(MAX_LIST_ITEMS)
}).strict();

const missingInformationSchema = z.object({
  items: z.array(z.object({
    question: shortTextSchema,
    whyItMatters: shortTextSchema,
    owner: shortTextSchema.optional()
  }).strict()).max(MAX_LIST_ITEMS)
}).strict();

const sourceEvidenceSchema = z.object({
  evidence: z.array(evidenceSummarySchema).max(MAX_LIST_ITEMS)
}).strict();

const confidenceAndReviewWarningsSchema = z.object({
  overallConfidence: z.number().finite().min(0).max(1),
  warnings: z.array(reviewWarningSchema).max(MAX_LIST_ITEMS)
}).strict();

/**
 * Canonical immutable DealBrief contract. Each explicit field maps to one of the
 * nine assignment sections, preserving evidence and review context for later rendering.
 */
export const dealBriefSchema = immutableSchema(withSerializedByteLimit(z.object({
  dealSnapshot: dealSnapshotSchema,
  executiveSummary: executiveSummarySchema,
  buyerGoalsAndBusinessDrivers: buyerGoalsAndBusinessDriversSchema,
  stakeholderMap: stakeholderMapSchema,
  negotiationState: negotiationStateSchema,
  recommendedNextActions: recommendedNextActionsSchema,
  missingInformation: missingInformationSchema,
  sourceEvidence: sourceEvidenceSchema,
  confidenceAndReviewWarnings: confidenceAndReviewWarningsSchema
}).strict()));

/** Bounded conversation-specialist result prior to strategy synthesis. */
export const conversationArtifactSchema = immutableSchema(withSerializedByteLimit(z.object({
  evidenceManifestId: evidenceManifestIdSchema,
  goals: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  concerns: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  commitments: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  objections: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  missingContext: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS),
  reviewWarnings: z.array(reviewWarningSchema).max(MAX_LIST_ITEMS)
}).strict()));

/** Bounded stakeholder-specialist result prior to strategy synthesis. */
export const stakeholderArtifactSchema = immutableSchema(withSerializedByteLimit(z.object({
  evidenceManifestId: evidenceManifestIdSchema,
  stakeholders: z.array(stakeholderSchema).max(MAX_LIST_ITEMS),
  coverageGaps: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS),
  reviewWarnings: z.array(reviewWarningSchema).max(MAX_LIST_ITEMS)
}).strict()));

/** Bounded commercial-and-policy-specialist result prior to strategy synthesis. */
export const commercialArtifactSchema = immutableSchema(withSerializedByteLimit(z.object({
  evidenceManifestId: evidenceManifestIdSchema,
  commercialTerms: z.array(z.object({
    term: shortTextSchema,
    status: z.enum(['proposed', 'agreed', 'blocked', 'unknown']),
    detail: shortTextSchema,
    claims: z.array(claimSchema).max(MAX_LIST_ITEMS)
  }).strict()).max(MAX_LIST_ITEMS),
  policyTriggers: z.array(shortTextSchema).max(MAX_LIST_ITEMS),
  claims: z.array(claimSchema).max(MAX_LIST_ITEMS),
  reviewWarnings: z.array(reviewWarningSchema).max(MAX_LIST_ITEMS)
}).strict()));

/** Strategy is the canonical DealBrief rather than a second, divergent output contract. */
export const strategyArtifactSchema = dealBriefSchema;

/** Immutable validated citation reference. */
export type Citation = z.infer<typeof citationSchema>;
/** Immutable validated factual claim. */
export type Claim = z.infer<typeof claimSchema>;
/** Immutable validated output-review warning. */
export type ReviewWarning = z.infer<typeof reviewWarningSchema>;
/** Immutable validated stakeholder record. */
export type Stakeholder = z.infer<typeof stakeholderSchema>;
/** Immutable validated recommended action. */
export type RecommendedAction = z.infer<typeof recommendedActionSchema>;
/** Immutable validated authorized evidence summary. */
export type EvidenceSummary = z.infer<typeof evidenceSummarySchema>;
/** Immutable canonical DealBrief with all nine assignment sections. */
export type DealBrief = z.infer<typeof dealBriefSchema>;
/** Immutable bounded conversation-specialist artifact. */
export type ConversationArtifact = z.infer<typeof conversationArtifactSchema>;
/** Immutable bounded stakeholder-specialist artifact. */
export type StakeholderArtifact = z.infer<typeof stakeholderArtifactSchema>;
/** Immutable bounded commercial-specialist artifact. */
export type CommercialArtifact = z.infer<typeof commercialArtifactSchema>;
/** Immutable strategy artifact, represented by the canonical DealBrief. */
export type StrategyArtifact = z.infer<typeof strategyArtifactSchema>;

type Assert<Condition extends true> = Condition;
type IsReadonlyArray<Value> = Value extends readonly unknown[]
  ? Value extends unknown[] ? false : true
  : false;
/** Compile-time checks that generated nested arrays remain readonly in public outputs. */
export type ReadonlyContractAssertions = [
  Assert<IsReadonlyArray<DealBrief['buyerGoalsAndBusinessDrivers']['goals']>>,
  Assert<IsReadonlyArray<DealBrief['stakeholderMap']['stakeholders']>>,
  Assert<IsReadonlyArray<ConversationArtifact['claims']>>,
  Assert<IsReadonlyArray<CommercialArtifact['commercialTerms']>>
];

export { MAX_SERIALIZED_ARTIFACT_BYTES };
