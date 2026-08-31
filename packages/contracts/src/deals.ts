import { z } from 'zod';
import { runStatusSchema } from './runs.js';

/** Confirms that an ISO-formatted date identifies a real calendar day. */
const isCalendarIsoDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date')
  .refine(isCalendarIsoDate, 'Expected a calendar-valid ISO date');
const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const dealSummarySchema = z
  .object({
    opportunityId: z.string().min(1).max(128),
    opportunityName: z.string().min(1).max(2_000),
    accountName: z.string().min(1).max(2_000),
    stage: z.string().min(1).max(256),
    owner: z.string().min(1).max(256).nullable(),
    closeDate: isoDateSchema.nullable(),
    amount: z.number().finite().nonnegative().nullable(),
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    probability: z.number().finite().min(0).max(100).nullable(),
    riskLevel: z.enum(['low', 'medium', 'high', 'unknown']),
    restricted: z.boolean(),
    createdAt: isoDateTimeSchema,
    latestRun: z
      .object({ status: runStatusSchema, updatedAt: isoDateTimeSchema })
      .strict()
      .nullable()
  })
  .strict();

export const dealListItemSchema = dealSummarySchema;
export const dealListResponseSchema = z
  .object({
    sessionVersion: z.string().min(1).max(256),
    deals: z.array(dealListItemSchema).max(1_000)
  })
  .strict();

export const evidenceDetailSchema = z
  .object({
    id: z.string().min(1).max(256),
    sourceType: z.enum([
      'gong_summary',
      'gong_transcript',
      'policy',
      'pricing',
      'salesforce',
      'slack'
    ]),
    sourcePath: z.string().min(1).max(2_000),
    stableKey: z.string().min(1).max(128),
    stableId: z.string().min(1).max(256),
    citationLabel: z.string().min(1).max(2_400),
    chunkId: z.string().min(1).max(256),
    capturedAt: isoDateTimeSchema,
    content: z.string().min(1).max(20_000)
  })
  .strict();

export const briefSectionSchema = z
  .object({
    title: z.string().min(1).max(256),
    paragraphs: z.array(z.string().min(1).max(8_000)).max(50),
    items: z.array(z.string().min(1).max(2_000)).max(50),
    citationIds: z.array(z.string().min(1).max(256)).max(100),
    accountTeamUpdateImpact: z.boolean()
  })
  .strict();

export const stakeholderViewSchema = z
  .object({
    name: z.string().min(1).max(256),
    title: z.string().min(1).max(256).nullable(),
    role: z.string().min(1).max(256),
    influence: z.string().min(1).max(128),
    relationship: z.string().min(1).max(128),
    goals: z.array(z.string().min(1).max(2_000)).max(50),
    concerns: z.array(z.string().min(1).max(2_000)).max(50),
    citationIds: z.array(z.string().min(1).max(256)).max(50)
  })
  .strict();

export const recommendedActionViewSchema = z
  .object({
    action: z.string().min(1).max(2_000),
    owner: z.string().min(1).max(256).nullable(),
    priority: z.enum(['low', 'medium', 'high', 'critical']),
    dueDate: isoDateSchema.nullable(),
    rationale: z.string().min(1).max(2_000),
    citationIds: z.array(z.string().min(1).max(256)).max(50),
    accountTeamUpdateImpact: z.boolean()
  })
  .strict();

export const reviewWarningViewSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'critical']),
    message: z.string().min(1).max(2_000),
    citationIds: z.array(z.string().min(1).max(256)).max(50),
    accountTeamUpdateImpact: z.boolean()
  })
  .strict();

const sectionsSchema = z
  .object({
    dealSnapshot: briefSectionSchema,
    executiveSummary: briefSectionSchema,
    buyerGoalsAndBusinessDrivers: briefSectionSchema,
    stakeholderMap: briefSectionSchema,
    negotiationState: briefSectionSchema,
    recommendedNextActions: briefSectionSchema,
    missingInformation: briefSectionSchema,
    sourceEvidence: briefSectionSchema,
    confidenceAndReviewWarnings: briefSectionSchema
  })
  .strict();

export const dealBriefViewSchema = z
  .object({
    status: z.enum(['source_backed', 'generated']),
    overallConfidence: z.number().finite().min(0).max(1),
    sections: sectionsSchema,
    stakeholders: z.array(stakeholderViewSchema).max(100),
    actions: z.array(recommendedActionViewSchema).max(100),
    warnings: z.array(reviewWarningViewSchema).max(100)
  })
  .strict();

/** Deterministic projection of currently authorized source records, never generated output. */
export const sourceSnapshotViewSchema = z
  .object({
    type: z.literal('source_snapshot'),
    label: z.literal('Source snapshot'),
    evidenceOverview: dealBriefViewSchema.extend({ status: z.literal('source_backed') }).strict()
  })
  .strict();

/** A generated artifact that remains explicitly linked to the run that produced it. */
export const generatedDealOutputViewSchema = z
  .object({
    type: z.literal('generated_output'),
    lifecycle: z.enum(['draft', 'finalized']),
    producingRun: z
      .object({
        id: z.string().min(1).max(256),
        status: runStatusSchema,
        updatedAt: isoDateTimeSchema
      })
      .strict(),
    content: dealBriefViewSchema.extend({ status: z.literal('generated') }).strict()
  })
  .strict();

export const dealWorkspaceViewSchema = z
  .object({
    sessionVersion: z.string().min(1).max(256),
    deal: dealSummarySchema,
    sourceSnapshot: sourceSnapshotViewSchema,
    generatedOutput: generatedDealOutputViewSchema.nullable(),
    /** @deprecated Use sourceSnapshot and generatedOutput, which do not conflate source records with generated content. */
    brief: dealBriefViewSchema,
    evidence: z.array(evidenceDetailSchema).max(500)
  })
  .strict();

export type DealListItem = z.infer<typeof dealListItemSchema>;
export type DealListResponse = z.infer<typeof dealListResponseSchema>;
export type DealWorkspaceView = z.infer<typeof dealWorkspaceViewSchema>;
export type DealBriefView = z.infer<typeof dealBriefViewSchema>;
export type SourceSnapshotView = z.infer<typeof sourceSnapshotViewSchema>;
export type GeneratedDealOutputView = z.infer<typeof generatedDealOutputViewSchema>;
export type BriefSectionView = z.infer<typeof briefSectionSchema>;
export type EvidenceDetail = z.infer<typeof evidenceDetailSchema>;
export type StakeholderView = z.infer<typeof stakeholderViewSchema>;
export type RecommendedActionView = z.infer<typeof recommendedActionViewSchema>;
export type ReviewWarningView = z.infer<typeof reviewWarningViewSchema>;
