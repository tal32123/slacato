import type {
  BoundedCompactionInput,
  ContextCheckpoint,
  ContextCheckpointBindings,
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

export class ContextBudgetError extends Error {
  public constructor(message: string) { super(message); this.name = 'ContextBudgetError'; }
}

function estimateTokens(content: string): number { return Math.ceil(content.length / CHARS_PER_TOKEN); }
function messageTokens(messages: readonly ModelMessage[]): number { return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0); }
function takeTokens(content: string, tokenLimit: number): string { return content.slice(0, Math.max(0, tokenLimit * CHARS_PER_TOKEN)); }
function copy(message: ModelMessage): ModelMessage { return { role: message.role, content: message.content }; }

function requireInvariant(label: string, content: string, budget: number): void {
  if (estimateTokens(content) > budget) throw new ContextBudgetError(`${label} invariant exceeds its section budget`);
}

function renderRequiredEvidence(sections: readonly ContextSection[], budget: number): string {
  const prefixes = sections.map((section) => `[evidence id=${section.id}]\n`);
  const requiredTokens = prefixes.reduce((total, prefix) => total + estimateTokens(prefix), 0);
  if (requiredTokens > budget) throw new ContextBudgetError('Evidence citation ID invariant exceeds its section budget');
  let used = requiredTokens;
  const rendered: string[] = [];
  for (const [index, section] of sections.entries()) {
    const prefix = prefixes[index];
    if (prefix === undefined) throw new ContextBudgetError('Evidence prefix was not prepared');
    const content = takeTokens(section.content, budget - used);
    const segment = `${prefix}${content}`;
    used += estimateTokens(content);
    rendered.push(segment);
  }
  return rendered.join('\n');
}

function renderOptionalSections(label: string, sections: readonly ContextSection[], budget: number): string {
  let used = 0;
  const rendered: string[] = [];
  for (const section of sections) {
    const prefix = `[${label} id=${section.id}]\n`;
    const prefixTokens = estimateTokens(prefix);
    if (used + prefixTokens > budget) break;
    const content = takeTokens(section.content, budget - used - prefixTokens);
    const segment = `${prefix}${content}`;
    used += estimateTokens(segment);
    rendered.push(segment);
  }
  return rendered.join('\n');
}

/** Deterministic, model-free budgeting that separates required invariants from optional material. */
export class ContextWindowPolicy {
  public constructor(private readonly settings: ContextWindowSettings) {
    if (settings.contextWindowTokens <= settings.reservedOutputTokens) throw new ContextBudgetError('Context window must exceed reserved output capacity');
  }

  public prepare(input: ContextWindowInput): PreparedContext {
    const budgets = this.settings.sectionTokenBudgets;
    const availableTokens = this.settings.contextWindowTokens - this.settings.reservedOutputTokens;
    const configuredTokens = budgets.instructions + budgets.currentTask + budgets.evidence + budgets.artifacts + budgets.history;
    if (configuredTokens > availableTokens) throw new ContextBudgetError('Section budgets exceed available input capacity');
    const task = `Current task:\n${input.currentTask}`;
    requireInvariant('System instructions', input.instructions, budgets.instructions);
    requireInvariant('Current task', task, budgets.currentTask);
    const evidence = renderRequiredEvidence(input.evidence ?? [], budgets.evidence);
    const invariantMessages: ModelMessage[] = [
      { role: 'system', content: input.instructions },
      { role: 'user', content: task },
      ...(evidence ? [{ role: 'user' as const, content: evidence }] : [])
    ];
    const invariantTokens = messageTokens(invariantMessages);
    if (invariantTokens > availableTokens) throw new ContextBudgetError('Required context invariants exceed available input capacity');
    const optionalMessages: ModelMessage[] = [];
    const artifacts = renderOptionalSections('artifact', input.artifacts ?? [], budgets.artifacts);
    if (artifacts) optionalMessages.push({ role: 'user', content: artifacts });
    let historyTokens = 0;
    const retainedHistory: ModelMessage[] = [];
    for (const message of [...(input.history ?? [])].reverse()) {
      const remaining = budgets.history - historyTokens;
      if (remaining <= 0) break;
      const content = message.content.slice(Math.max(0, message.content.length - remaining * CHARS_PER_TOKEN));
      const tokenCount = estimateTokens(content);
      if (tokenCount > remaining) continue;
      retainedHistory.unshift({ role: message.role, content });
      historyTokens += tokenCount;
    }
    optionalMessages.push(...retainedHistory);
    const messages = [...invariantMessages, ...optionalMessages];
    const inputTokens = messageTokens(messages);
    if (inputTokens > availableTokens) throw new ContextBudgetError('Prepared context exceeds available input capacity');
    return { messages, invariantMessages, optionalMessages, inputTokens, reservedOutputTokens: this.settings.reservedOutputTokens };
  }

  /** Preserves invariants first; repair/schema material can occupy only residual capacity. */
  public rebudget(prepared: PreparedContext, supplemental: readonly ModelMessage[]): readonly ModelMessage[] {
    const availableTokens = this.settings.contextWindowTokens - this.settings.reservedOutputTokens;
    const invariants = prepared.invariantMessages.map(copy);
    const invariantTokens = messageTokens(invariants);
    if (invariantTokens > availableTokens) throw new ContextBudgetError('Required context invariants exceed available input capacity');
    let remainingChars = (availableTokens - invariantTokens) * CHARS_PER_TOKEN;
    const retained: ModelMessage[] = [];
    for (const message of [...prepared.optionalMessages, ...supplemental].reverse()) {
      if (remainingChars <= 0) break;
      const content = message.content.slice(0, remainingChars);
      retained.unshift({ role: message.role, content });
      remainingChars -= content.length;
    }
    const result = [...invariants, ...retained];
    if (messageTokens(result) > availableTokens) throw new ContextBudgetError('Rebudgeted context exceeds available input capacity');
    return result;
  }

  public rebudgetRaw(messages: readonly ModelMessage[]): readonly ModelMessage[] {
    let remainingChars = (this.settings.contextWindowTokens - this.settings.reservedOutputTokens) * CHARS_PER_TOKEN;
    const retained: ModelMessage[] = [];
    for (const message of [...messages].reverse()) {
      if (remainingChars <= 0) break;
      const content = message.content.slice(0, remainingChars);
      retained.unshift({ role: message.role, content });
      remainingChars -= content.length;
    }
    if (messageTokens(retained) > this.settings.contextWindowTokens - this.settings.reservedOutputTokens) throw new ContextBudgetError('Rebudgeted context exceeds available input capacity');
    return retained;
  }
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}

function validBindings(value: unknown): value is ContextCheckpointBindings {
  const record = asPlainRecord(value);
  if (record === undefined) return false;
  return ['scopeHash', 'policyHash', 'evidenceHash', 'promptHash', 'schemaHash', 'modelHash', 'validationHash']
    .every((key) => Object.prototype.hasOwnProperty.call(record, key) && typeof record[key] === 'string' && record[key].length > 0);
}

function assertCheckpoint(value: unknown, input: BoundedCompactionInput): asserts value is ContextCheckpoint {
  const record = asPlainRecord(value);
  if (record === undefined || !Object.prototype.hasOwnProperty.call(record, 'coveredMessageRange') || !Object.prototype.hasOwnProperty.call(record, 'summary') || !Object.prototype.hasOwnProperty.call(record, 'validationState')) throw new ContextBudgetError('Compactor returned a malformed checkpoint');
  const checkpoint = value as ContextCheckpoint;
  if (!validBindings(checkpoint) || checkpoint.summary.length === 0 || checkpoint.validationState !== 'validated') throw new ContextBudgetError('Compactor returned an unvalidated checkpoint');
  const range = asPlainRecord(checkpoint.coveredMessageRange);
  if (range === undefined || !Object.prototype.hasOwnProperty.call(range, 'from') || !Object.prototype.hasOwnProperty.call(range, 'to')
    || !Number.isInteger(checkpoint.coveredMessageRange.from) || !Number.isInteger(checkpoint.coveredMessageRange.to)
    || checkpoint.coveredMessageRange.from !== input.coveredMessageRange.from || checkpoint.coveredMessageRange.to !== input.coveredMessageRange.to) throw new ContextBudgetError('Compactor returned an invalid covered message range');
  if (!isContextCheckpointReusable(checkpoint, input.bindings)) throw new ContextBudgetError('Compactor checkpoint bindings do not match the request');
}

/** Bounded one-step compaction using a non-recursive gateway and validated checkpoints. */
export function createNonRecursiveContextCompactor(gateway: NonRecursiveCompactionGateway, policy: ContextWindowPolicy): ContextCompactor {
  return {
    async compact(input: BoundedCompactionInput): Promise<ContextCheckpoint> {
      if (input.priorInvocations >= 1) throw new ContextBudgetError('Repeated compaction is not allowed');
      if (input.maxSteps !== 1 || input.maxRetries !== 0) throw new ContextBudgetError('Compaction permits exactly one step and no retries');
      if (input.maxInputTokens <= 1 || input.maxOutputTokens <= 0) throw new ContextBudgetError('Compaction input/output limits are invalid');
      if (input.maxInputTokens > MAX_COMPACTION_INPUT_TOKENS || input.maxOutputTokens > MAX_COMPACTION_OUTPUT_TOKENS) throw new ContextBudgetError('Compaction token limits exceed the hard safety cap');
      const prepared = policy.prepare({ ...input.context, history: input.history });
      if (prepared.inputTokens > input.maxInputTokens) throw new ContextBudgetError('Prepared compaction input exceeds maxInputTokens');
      const checkpoint = await gateway.compact({ mode: 'non_recursive', context: prepared, maxInputTokens: input.maxInputTokens, maxOutputTokens: input.maxOutputTokens, maxSteps: 1, maxRetries: 0 });
      assertCheckpoint(checkpoint, input);
      if (estimateTokens(JSON.stringify(checkpoint)) > input.maxOutputTokens) throw new ContextBudgetError('Compactor output exceeds maxOutputTokens');
      return checkpoint;
    }
  };
}

/** Checkpoint reuse requires a validated checkpoint and exact recomputed bindings. */
export function isContextCheckpointReusable(checkpoint: ContextCheckpoint, current: ContextCheckpointBindings): boolean {
  return checkpoint.validationState === 'validated' && validBindings(checkpoint)
    && checkpoint.scopeHash === current.scopeHash && checkpoint.policyHash === current.policyHash
    && checkpoint.evidenceHash === current.evidenceHash && checkpoint.promptHash === current.promptHash
    && checkpoint.schemaHash === current.schemaHash && checkpoint.modelHash === current.modelHash
    && checkpoint.validationHash === current.validationHash;
}
