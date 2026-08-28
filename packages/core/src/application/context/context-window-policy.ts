import type {
  BoundedCompactionInput,
  ContextCheckpoint,
  ContextCompactor,
  ContextSection,
  ContextWindowInput,
  ContextWindowSettings,
  ModelMessage,
  NonRecursiveCompactionGateway,
  PreparedContext
} from './contracts.js';

const CHARS_PER_TOKEN = 4;
const MAX_COMPACTION_INPUT_TOKENS = 16_384;
const MAX_COMPACTION_OUTPUT_TOKENS = 2_048;

function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

function bounded(content: string, tokens: number): string {
  return content.slice(0, Math.max(0, tokens * CHARS_PER_TOKEN));
}

function renderSections(label: string, sections: readonly ContextSection[], tokenBudget: number): string {
  let remaining = tokenBudget * CHARS_PER_TOKEN;
  const chunks: string[] = [];
  for (const section of sections) {
    if (remaining <= 0) break;
    const prefix = `[${label} id=${section.id}]\n`;
    const content = bounded(section.content, Math.max(0, Math.floor((remaining - prefix.length) / CHARS_PER_TOKEN)));
    const rendered = `${prefix}${content}`;
    chunks.push(rendered);
    remaining -= rendered.length;
  }
  return chunks.join('\n');
}

/**
 * Deterministically prunes independent context sections. It is model-free and
 * never changes raw history, so callers can safely persist/rebuild it.
 */
export class ContextWindowPolicy {
  public constructor(private readonly settings: ContextWindowSettings) {
    if (settings.contextWindowTokens <= settings.reservedOutputTokens) {
      throw new Error('Context window must exceed reserved output capacity');
    }
  }

  public prepare(input: ContextWindowInput): PreparedContext {
    const budgets = this.settings.sectionTokenBudgets;
    const maximumInputTokens = this.settings.contextWindowTokens - this.settings.reservedOutputTokens;
    const configuredTokens = budgets.instructions + budgets.currentTask + budgets.evidence + budgets.artifacts + budgets.history;
    if (configuredTokens > maximumInputTokens) throw new Error('Section budgets exceed available input capacity');

    const messages: ModelMessage[] = [
      { role: 'system', content: bounded(input.instructions, budgets.instructions) },
      { role: 'user', content: bounded(`Current task:\n${input.currentTask}`, budgets.currentTask) }
    ];
    const evidence = renderSections('evidence', input.evidence ?? [], budgets.evidence);
    if (evidence) messages.push({ role: 'user', content: evidence });
    const artifacts = renderSections('artifact', input.artifacts ?? [], budgets.artifacts);
    if (artifacts) messages.push({ role: 'user', content: artifacts });

    const history = input.history ?? [];
    let remainingHistory = budgets.history * CHARS_PER_TOKEN;
    const retainedHistory: ModelMessage[] = [];
    for (const message of [...history].reverse()) {
      if (remainingHistory <= 0) break;
      const content = message.content.slice(Math.max(0, message.content.length - remainingHistory));
      retainedHistory.unshift({ role: message.role, content });
      remainingHistory -= content.length;
    }
    messages.push(...retainedHistory);

    return {
      messages,
      inputTokens: messages.reduce((total, message) => total + estimateTokens(message.content), 0),
      reservedOutputTokens: this.settings.reservedOutputTokens
    };
  }

  /** Re-budgets a repaired prompt without mutating it; latest corrective feedback wins. */
  public rebudget(messages: readonly ModelMessage[]): readonly ModelMessage[] {
    let remaining = (this.settings.contextWindowTokens - this.settings.reservedOutputTokens) * CHARS_PER_TOKEN;
    const retained: ModelMessage[] = [];
    for (const message of [...messages].reverse()) {
      if (remaining <= 0) break;
      const content = message.content.slice(0, remaining);
      retained.unshift({ role: message.role, content });
      remaining -= content.length;
    }
    return retained;
  }
}

/** Bounded, one-step compaction adapter with no path back to model generation. */
export function createNonRecursiveContextCompactor(gateway: NonRecursiveCompactionGateway): ContextCompactor & {
  compact(input: BoundedCompactionInput): Promise<ContextCheckpoint>;
} {
  return {
    async compact(input: BoundedCompactionInput): Promise<ContextCheckpoint> {
      if (input.priorInvocations >= 1) throw new Error('Repeated compaction is not allowed');
      if (input.maxInputTokens <= 0 || input.maxOutputTokens <= 0) throw new Error('Compaction token limits must be positive');
      if (input.maxInputTokens > MAX_COMPACTION_INPUT_TOKENS || input.maxOutputTokens > MAX_COMPACTION_OUTPUT_TOKENS) {
        throw new Error('Compaction token limits exceed the hard safety cap');
      }
      return gateway.compact({
        mode: 'non_recursive',
        history: input.history.map((message) => ({ role: message.role, content: message.content })),
        maxInputTokens: input.maxInputTokens,
        maxOutputTokens: input.maxOutputTokens
      });
    }
  };
}

/** Reuse is allowed only after all authorization and generation inputs are recomputed identically. */
export function isContextCheckpointReusable(
  checkpoint: ContextCheckpoint,
  current: Pick<ContextCheckpoint, 'scopeHash' | 'policyHash' | 'evidenceHash' | 'promptHash' | 'schemaHash' | 'modelHash' | 'validationHash'>
): boolean {
  return checkpoint.scopeHash === current.scopeHash
    && checkpoint.policyHash === current.policyHash
    && checkpoint.evidenceHash === current.evidenceHash
    && checkpoint.promptHash === current.promptHash
    && checkpoint.schemaHash === current.schemaHash
    && checkpoint.modelHash === current.modelHash
    && checkpoint.validationHash === current.validationHash;
}
