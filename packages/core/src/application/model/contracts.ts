import type { z } from 'zod';
import type { ContextWindowInput, ModelMessage } from '../context/contracts.js';
import type { ProviderAttemptContext } from './provider-attempt-ledger.js';

export type { ModelMessage } from '../context/contracts.js';

export type OutputMode = 'native_schema' | 'prompted_json';

export type RetryLimits = Readonly<{
  maxCalls: number;
  maxSchemaRepairs: number;
  maxTransportRetries: number;
  deadlineMs: number;
}>;

export type RunBudgetLimits = Readonly<{
  scope: string;
  maxCalls: number;
  deadlineMs: number;
}>;

export type ModelErrorCategory =
  | 'transient_transport'
  | 'rate_limited'
  | 'server'
  | 'authorization'
  | 'policy'
  | 'content_filter'
  | 'deterministic_validation'
  | 'deterministic_citation'
  | 'nonretryable_client'
  | 'unknown';

export type OutputReservation = Readonly<{ grantedOutputTokens: number; id: number }>;

export interface SharedRunBudget {
  readonly scope: string;
  reserveAttempt(inputTokens: number, requestedOutputTokens: number): OutputReservation;
  reconcileInputTokens(reservedTokens: number, consumedTokens: number | undefined): void;
  settleAttempt(reservation: OutputReservation, actualOutputTokens: number | undefined): void;
  releaseAttempt(reservation: OutputReservation): void;
  assertDeadline(): void;
}

export type NormalizedValidationIssue = Readonly<{
  path: string;
  code: string;
  message: string;
}>;

export type GenerationAttempt = Readonly<{
  outputMode: OutputMode;
  validationIssues: readonly NormalizedValidationIssue[];
}>;

export type GenerationResult<Value> = Readonly<{
  value: Value;
  attempts: readonly GenerationAttempt[];
  outputMode: OutputMode;
  usage: Readonly<{ inputTokens?: number | undefined; outputTokens?: number | undefined }>;
  warnings: readonly string[];
}>;

export type GenerateObjectRequest<Value> = Readonly<{
  schema: z.ZodType<Value>;
  messages: readonly ModelMessage[];
  operation: string;
  limits: RetryLimits;
  budget?: SharedRunBudget;
  /** Required durable accounting context for every provider transport invocation. */
  durableAttempt: ProviderAttemptContext;
  context?: ContextWindowInput;
}>;

export type TransportGeneration<Value = unknown> = Readonly<{
  text?: string;
  output?: Value;
  usage?: Readonly<{ inputTokens?: number | undefined; outputTokens?: number | undefined }>;
  warnings?: readonly string[];
  requestId?: string;
  responseId?: string;
}>;

export type NormalizedModelError = Readonly<{
  category: ModelErrorCategory;
  diagnosticCode?: string;
  statusCode?: number;
  message?: string;
  /** Only adapters with reliable delivery evidence may mark a request as not sent. */
  delivery?: 'safe_not_sent' | 'possibly_sent';
}>;

export type ModelTransportRequest<Value> = Readonly<{
  messages: readonly ModelMessage[];
  operation: string;
  outputMode: OutputMode;
  schema?: z.ZodType<Value>;
  deadlineAt: number;
}>;

/** Private-adapter port; application code uses BudgetedModelGateway instead. */
export interface ModelTransport {
  readonly capabilities: Readonly<{ nativeStructuredOutput: boolean }>;
  generate<Value>(request: ModelTransportRequest<Value>): Promise<TransportGeneration<Value>>;
}

/** The sole public seam used by applications, agents, and scripts. */
export interface BudgetedModelGateway {
  generateObject<Value>(request: GenerateObjectRequest<Value>): Promise<GenerationResult<Value>>;
}

export interface EmbeddingGateway {
  embed(values: readonly string[]): Promise<number[][]>;
}
