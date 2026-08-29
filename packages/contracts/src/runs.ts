import { z } from 'zod';

const opaqueIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const runStatusSchema = z.enum([
  'created',
  'retrieving',
  'specialists_running',
  'synthesizing',
  'validating',
  'awaiting_approval',
  'finalizing',
  'completed',
  'rejected',
  'failed'
]);

export const runBudgetSchema = z.object({
  maxCalls: z.number().int().positive(),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  deadlineMs: z.number().int().min(1_000)
}).strict();

export const startBriefRequestSchema = z.object({
  opportunityId: opaqueIdSchema,
  idempotencyKey: z.string().min(1).max(256),
  budget: runBudgetSchema
}).strict();

export const startBriefResponseSchema = z.object({ runId: opaqueIdSchema }).strict();

export const runListItemSchema = z.object({
  runId: opaqueIdSchema,
  opportunityId: opaqueIdSchema,
  opportunityName: z.string().min(1).max(2_000),
  accountName: z.string().min(1).max(2_000),
  initiatedBy: z.string().min(1).max(256),
  status: runStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();

export const runListResponseSchema = z.object({
  sessionVersion: z.string().min(1).max(256),
  runs: z.array(runListItemSchema).max(1_000)
}).strict();

export const runSpecialistStatusSchema = z.object({
  name: z.enum(['conversation', 'stakeholder', 'commercial']),
  status: z.enum(['pending', 'running', 'completed', 'degraded', 'failed'])
}).strict();

export const runTimelineItemSchema = z.object({
  sequence: z.number().int().positive(),
  eventId: opaqueIdSchema,
  phase: runStatusSchema,
  label: z.string().min(1).max(256),
  at: timestampSchema
}).strict();

export const runProgressSchema = z.object({
  phase: runStatusSchema,
  retrievalCount: z.number().int().nonnegative(),
  validationRetries: z.number().int().nonnegative(),
  specialists: z.array(runSpecialistStatusSchema).max(3),
  completedSections: z.array(z.string().min(1).max(256)).max(9),
  timeline: z.array(runTimelineItemSchema).max(200)
}).strict();

export const runDetailResponseSchema = z.object({
  sessionVersion: z.string().min(1).max(256),
  runId: opaqueIdSchema,
  opportunityId: opaqueIdSchema,
  opportunityName: z.string().min(1).max(2_000),
  accountName: z.string().min(1).max(2_000),
  initiatedBy: z.string().min(1).max(256),
  status: runStatusSchema,
  version: z.number().int().nonnegative(),
  watermark: opaqueIdSchema.nullable(),
  watermarkSequence: z.number().int().nonnegative(),
  terminal: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  progress: runProgressSchema
}).strict();

export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunBudget = z.infer<typeof runBudgetSchema>;
export type StartBriefRequest = z.infer<typeof startBriefRequestSchema>;
export type StartBriefResponse = z.infer<typeof startBriefResponseSchema>;
export type RunListItem = z.infer<typeof runListItemSchema>;
export type RunListResponse = z.infer<typeof runListResponseSchema>;
export type RunProgress = z.infer<typeof runProgressSchema>;
export type RunDetailResponse = z.infer<typeof runDetailResponseSchema>;
