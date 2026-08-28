/** Provider-neutral text message used at the model boundary. */
export type ModelMessage = Readonly<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}>;

export type ContextSection = Readonly<{ id: string; content: string }>;

/** Raw immutable history is never modified by context preparation or compaction. */
export type ContextWindowInput = Readonly<{
  instructions: string;
  currentTask: string;
  evidence?: readonly ContextSection[];
  artifacts?: readonly ContextSection[];
  history?: readonly ModelMessage[];
}>;

export type ContextWindowSettings = Readonly<{
  contextWindowTokens: number;
  reservedOutputTokens: number;
  sectionTokenBudgets: Readonly<{
    instructions: number;
    currentTask: number;
    evidence: number;
    artifacts: number;
    history: number;
  }>;
}>;

export type PreparedContext = Readonly<{
  messages: readonly ModelMessage[];
  inputTokens: number;
  reservedOutputTokens: number;
}>;

/** A persisted, validated summary of a bounded, explicit history range. */
export type ContextCheckpoint = Readonly<{
  coveredMessageRange: Readonly<{ from: number; to: number }>;
  summary: string;
  scopeHash: string;
  policyHash: string;
  evidenceHash: string;
  promptHash: string;
  schemaHash: string;
  modelHash: string;
  validationHash: string;
}>;

/** A compactor deliberately has no recursive access to itself. */
export interface ContextCompactor {
  compact(input: Readonly<{ history: readonly ModelMessage[]; maxOutputTokens: number }>): Promise<ContextCheckpoint>;
}

export type NonRecursiveCompactionInput = Readonly<{
  mode: 'non_recursive';
  history: readonly ModelMessage[];
  maxInputTokens: number;
  maxOutputTokens: number;
}>;

/** This narrow port prevents a compaction call from re-entering the compactor. */
export interface NonRecursiveCompactionGateway {
  compact(input: NonRecursiveCompactionInput): Promise<ContextCheckpoint>;
}

export type BoundedCompactionInput = Readonly<{
  history: readonly ModelMessage[];
  maxInputTokens: number;
  maxOutputTokens: number;
  priorInvocations: number;
}>;
