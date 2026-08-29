import { z } from 'zod';
import { runStatusSchema } from './runs.js';

const opaqueIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.iso.datetime({ offset: true });
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const shortTextSchema = z.string().min(1).max(2_000);
const sectionTextSchema = z.string().min(1).max(8_000);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const approvalCategorySchema = z.enum(['commercial_discount', 'legal_terms', 'evidence_review', 'customer_concession']);
export const approvalAuthoritySchema = z.enum(['deal_desk', 'sales_leader', 'legal_reviewer', 'account_owner']);
export const approvalActionSchema = z.enum(['approve_unchanged', 'edit_and_approve', 'reject']);

const citationSchema = z.object({
  id: opaqueIdSchema,
  evidenceId: opaqueIdSchema,
  locator: shortTextSchema,
  rationale: shortTextSchema.optional()
}).strict();
const claimSchema: z.ZodType = z.object({
  id: opaqueIdSchema,
  statement: shortTextSchema,
  confidence: z.number().finite().min(0).max(1),
  citations: z.array(citationSchema).max(10)
}).strict();
const stakeholderSchema = z.object({
  name: shortTextSchema,
  title: shortTextSchema.optional(),
  organization: shortTextSchema.optional(),
  role: z.enum(['economic_buyer', 'champion', 'decision_maker', 'evaluator', 'influencer', 'legal', 'procurement', 'unknown']),
  influence: z.enum(['low', 'medium', 'high']),
  relationship: z.enum(['unknown', 'negative', 'neutral', 'positive']),
  goals: z.array(shortTextSchema).max(50),
  concerns: z.array(shortTextSchema).max(50),
  claims: z.array(claimSchema).max(50)
}).strict();
const actionSchema = z.object({
  action: shortTextSchema,
  owner: shortTextSchema.optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  rationale: shortTextSchema,
  dueDate: dateSchema.optional(),
  claims: z.array(claimSchema).max(50)
}).strict();
const warningSchema = z.object({
  code: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/),
  severity: z.enum(['info', 'warning', 'critical']),
  message: shortTextSchema,
  claimIds: z.array(opaqueIdSchema).max(50)
}).strict();
const evidenceSummarySchema = z.object({
  evidenceId: opaqueIdSchema,
  sourceType: z.enum(['crm', 'conversation', 'policy', 'pricing', 'slack', 'other']),
  summary: shortTextSchema,
  capturedAt: timestampSchema,
  claims: z.array(claimSchema).max(50)
}).strict();

export const approvalBriefPayloadSchema = z.object({
  dealSnapshot: z.object({
    accountName: shortTextSchema,
    opportunityName: shortTextSchema,
    stage: shortTextSchema,
    closeDate: dateSchema.optional(),
    amount: z.number().finite().nonnegative().optional(),
    currency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),
    owner: shortTextSchema.optional(),
    claims: z.array(claimSchema).max(50).optional()
  }).strict(),
  executiveSummary: z.object({ narrative: sectionTextSchema, claims: z.array(claimSchema).max(50).optional() }).strict(),
  buyerGoalsAndBusinessDrivers: z.object({
    goals: z.array(shortTextSchema).max(50), businessDrivers: z.array(shortTextSchema).max(50),
    claims: z.array(claimSchema).max(50).optional()
  }).strict(),
  stakeholderMap: z.object({
    stakeholders: z.array(stakeholderSchema).max(50), coverageGaps: z.array(shortTextSchema).max(50).optional(),
    claims: z.array(claimSchema).max(50).optional()
  }).strict(),
  negotiationState: z.object({
    currentState: sectionTextSchema, leverage: z.array(shortTextSchema).max(50).optional(), risks: z.array(shortTextSchema).max(50),
    claims: z.array(claimSchema).max(50).optional()
  }).strict(),
  recommendedNextActions: z.object({ actions: z.array(actionSchema).max(50) }).strict(),
  missingInformation: z.object({ items: z.array(z.object({
    question: shortTextSchema, whyItMatters: shortTextSchema, owner: shortTextSchema.optional()
  }).strict()).max(50) }).strict(),
  sourceEvidence: z.object({ evidence: z.array(evidenceSummarySchema).max(50) }).strict(),
  confidenceAndReviewWarnings: z.object({
    overallConfidence: z.number().finite().min(0).max(1), warnings: z.array(warningSchema).max(50)
  }).strict()
}).strict();

const decisionBaseSchema = z.object({
  runId: opaqueIdSchema,
  approvalSubjectId: opaqueIdSchema,
  expectedRunVersion: z.number().int().nonnegative(),
  expectedSubjectHash: hashSchema,
  entryId: opaqueIdSchema,
  category: approvalCategorySchema,
  authority: approvalAuthoritySchema,
  idempotencyKey: z.string().min(1).max(256)
}).strict();

export const approvalDecisionRequestSchema = z.discriminatedUnion('action', [
  decisionBaseSchema.extend({
    action: z.literal('approve_unchanged'),
    rationale: z.string().min(1).max(4_000).optional()
  }).strict(),
  decisionBaseSchema.extend({
    action: z.literal('edit_and_approve'),
    rationale: z.string().min(1).max(4_000),
    editedPayload: approvalBriefPayloadSchema
  }).strict(),
  decisionBaseSchema.extend({
    action: z.literal('reject'),
    rationale: z.string().min(1).max(4_000)
  }).strict()
]);

export const approvalDecisionResultSchema = z.object({
  status: z.enum(['awaiting_approval', 'finalizing', 'rejected']),
  runVersion: z.number().int().nonnegative(),
  approvalSubjectId: opaqueIdSchema,
  entryId: opaqueIdSchema,
  approvedSubjectHash: hashSchema,
  quorumSatisfied: z.boolean(),
  replayed: z.boolean()
}).strict();

export const approvalDecisionViewSchema = z.object({
  action: approvalActionSchema,
  actorName: z.string().min(1).max(256),
  authority: approvalAuthoritySchema,
  rationale: z.string().max(4_000).nullable(),
  decidedAt: timestampSchema,
  changed: z.boolean()
}).strict();

export const approvalInboxEntrySchema = z.object({
  approvalSubjectId: opaqueIdSchema,
  runId: opaqueIdSchema,
  runVersion: z.number().int().nonnegative(),
  subjectHash: hashSchema,
  opportunityId: opaqueIdSchema,
  opportunityName: z.string().min(1).max(2_000),
  accountName: z.string().min(1).max(2_000),
  entryId: opaqueIdSchema,
  category: approvalCategorySchema,
  requiredAuthorities: z.array(approvalAuthoritySchema).min(1).max(4),
  availableAuthority: approvalAuthoritySchema,
  assignedApprover: z.string().min(1).max(256).nullable(),
  quorum: z.object({ completed: z.number().int().nonnegative(), required: z.number().int().positive() }).strict(),
  ageStartedAt: timestampSchema,
  updatedAt: timestampSchema,
  decision: approvalDecisionViewSchema.nullable()
}).strict();

export const approvalInboxResponseSchema = z.object({
  sessionVersion: z.string().min(1).max(256),
  pending: z.array(approvalInboxEntrySchema).max(1_000),
  history: z.array(approvalInboxEntrySchema).max(1_000)
}).strict();

export const approvalRequirementViewSchema = z.object({
  entryId: opaqueIdSchema,
  category: approvalCategorySchema,
  requiredAuthorities: z.array(approvalAuthoritySchema).min(1).max(4),
  availableAuthority: approvalAuthoritySchema.nullable(),
  dependsOn: z.array(opaqueIdSchema).max(20),
  decided: z.boolean()
}).strict();

export const approvalDetailResponseSchema = z.object({
  sessionVersion: z.string().min(1).max(256),
  approvalSubjectId: opaqueIdSchema,
  runId: opaqueIdSchema,
  runVersion: z.number().int().nonnegative(),
  subjectHash: hashSchema,
  opportunityId: opaqueIdSchema,
  opportunityName: z.string().min(1).max(2_000),
  accountName: z.string().min(1).max(2_000),
  status: runStatusSchema,
  payload: approvalBriefPayloadSchema,
  entries: z.array(approvalRequirementViewSchema).min(1).max(20),
  decisions: z.array(approvalDecisionViewSchema).max(20),
  quorum: z.object({ completed: z.number().int().nonnegative(), required: z.number().int().positive() }).strict(),
  createdAt: timestampSchema,
  supersededBySubjectId: opaqueIdSchema.nullable()
}).strict();

export type ApprovalCategory = z.infer<typeof approvalCategorySchema>;
export type ApprovalAuthority = z.infer<typeof approvalAuthoritySchema>;
export type ApprovalAction = z.infer<typeof approvalActionSchema>;
export type ApprovalBriefPayload = z.infer<typeof approvalBriefPayloadSchema>;
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequestSchema>;
export type ApprovalDecisionResult = z.infer<typeof approvalDecisionResultSchema>;
export type ApprovalDecisionView = z.infer<typeof approvalDecisionViewSchema>;
export type ApprovalInboxEntry = z.infer<typeof approvalInboxEntrySchema>;
export type ApprovalInboxResponse = z.infer<typeof approvalInboxResponseSchema>;
export type ApprovalDetailResponse = z.infer<typeof approvalDetailResponseSchema>;
