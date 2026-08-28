import { z } from 'zod';
import type { ContextWindowInput, ModelMessage } from '../context/contracts.js';

export type { ModelMessage } from '../context/contracts.js';

export type OutputMode = 'native_schema' | 'prompted_json';

export type RetryLimits = Readonly<{
  maxCalls: number;
  maxSchemaRepairs: number;
  maxTransportRetries: number;
  deadlineMs: number;
  maxOutputTokens: number;
}>;

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
  context?: ContextWindowInput;
}>;

export type TransportGeneration<Value = unknown> = Readonly<{
  text?: string;
  output?: Value;
  usage?: Readonly<{ inputTokens?: number | undefined; outputTokens?: number | undefined }>;
  warnings?: readonly string[];
}>;

export type ModelTransportRequest<Value> = Readonly<{
  messages: readonly ModelMessage[];
  operation: string;
  outputMode: OutputMode;
  schema?: z.ZodType<Value>;
  maxOutputTokens: number;
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
