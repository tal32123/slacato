import { z } from 'zod';
import { MAX_LIST_ITEMS } from '../../domain/briefs/schema.js';
import { DomainValidationError } from '../../domain/shared/errors.js';
import { buildAgentPrompt, pruneAgentEvidence } from '../briefs/prompts.js';
import type { BudgetedModelGateway } from '../model/contracts.js';
import type { AgentContext, AgentEvidenceRecord } from './contracts.js';
import { assertAgentContextBindings } from './validation.js';

/** Restores manifest-owned citation fields so generated artifacts cannot alter evidence identity. */
function canonicalizeCodeOwnedFields<Value>(
  value: Value,
  manifestId: string,
  evidence: readonly AgentEvidenceRecord[]
): Value {
  const byCitationId = new Map(evidence.map((record) => [record.citationId, record]));
  const byEvidenceId = new Map(evidence.map((record) => [record.evidenceId, record]));
  const byLocator = new Map(evidence.map((record) => [record.sourceLocator, record]));

  const canonicalizeCitation = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      return candidate;
    const citation = candidate as Record<string, unknown>;
    const matches = new Set<AgentEvidenceRecord>();
    if (typeof citation.id === 'string') {
      const match = byCitationId.get(citation.id as AgentEvidenceRecord['citationId']);
      if (match !== undefined) matches.add(match);
    }
    if (typeof citation.evidenceId === 'string') {
      const match = byEvidenceId.get(citation.evidenceId);
      if (match !== undefined) matches.add(match);
    }
    if (typeof citation.locator === 'string') {
      const match = byLocator.get(citation.locator);
      if (match !== undefined) matches.add(match);
    }
    if (matches.size !== 1) return candidate;
    const [record] = matches;
    if (record === undefined) throw new Error('Expected exactly one matching evidence record');
    return {
      ...citation,
      id: record.citationId,
      evidenceId: record.evidenceId,
      locator: record.sourceLocator
    };
  };

  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (current === null || typeof current !== 'object') return current;
    const result = Object.fromEntries(
      Object.entries(current as Record<string, unknown>).map(([key, entry]) => [key, visit(entry)])
    );
    if (Array.isArray(result.citations))
      result.citations = result.citations.map(canonicalizeCitation);
    return result;
  };

  const canonical = visit(value);
  if (
    canonical !== null &&
    typeof canonical === 'object' &&
    !Array.isArray(canonical) &&
    Object.hasOwn(canonical, 'evidenceManifestId')
  ) {
    (canonical as Record<string, unknown>).evidenceManifestId = manifestId;
  }
  return canonical as Value;
}

/** Extracts bounded schema-owned review codes without retaining claims, evidence, or citations. */
function artifactReviewWarningCodes(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const artifact = value as Record<string, unknown>;
  const confidence = artifact.confidenceAndReviewWarnings;
  const warningCandidates: readonly unknown[] = Array.isArray(artifact.reviewWarnings)
    ? artifact.reviewWarnings
    : confidence !== null &&
        typeof confidence === 'object' &&
        !Array.isArray(confidence) &&
        Array.isArray((confidence as Record<string, unknown>).warnings)
      ? ((confidence as Record<string, unknown>).warnings as readonly unknown[])
      : [];
  const codes: string[] = [];
  for (const candidate of warningCandidates) {
    if (codes.length === MAX_LIST_ITEMS) break;
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const code = (candidate as Record<string, unknown>).code;
    if (typeof code === 'string' && code.length <= 128 && /^[A-Z][A-Z0-9_]*$/.test(code))
      codes.push(code);
  }
  return codes;
}

/** Builds an evidence-bounded prompt, generates an artifact, and applies its deterministic validation. */
export async function runAgent<Value>(
  input: Readonly<{
    gateway: BudgetedModelGateway;
    context: AgentContext;
    operation: string;
    task: string;
    schema: z.ZodType<Value>;
    allowedSourceTypes: ReadonlySet<AgentEvidenceRecord['sourceType']>;
    artifacts?: readonly Readonly<{ id: string; value: unknown }>[];
    citedIds?: ReadonlySet<string>;
    validate?: (value: Value, evidence: readonly AgentEvidenceRecord[]) => Value;
  }>
): Promise<Readonly<{ value: Value; evidence: readonly AgentEvidenceRecord[] }>> {
  assertAgentContextBindings(input.context);
  const evidence = pruneAgentEvidence(
    input.context.evidence,
    input.allowedSourceTypes,
    input.citedIds
  );
  const prompt = buildAgentPrompt({
    task: input.task,
    trustedContext: {
      runId: input.context.runId,
      manifestId: input.context.manifest.id,
      accountId: input.context.account.id,
      accountName: input.context.account.name,
      opportunityId: input.context.opportunity.id,
      opportunityName: input.context.opportunity.name,
      opportunityStage: input.context.opportunity.stage
    },
    evidence,
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts })
  });
  const validatedSchema =
    input.validate === undefined
      ? input.schema
      : input.schema.transform((value, issueContext) => {
          try {
            return input.validate?.(value, evidence) ?? value;
          } catch (error) {
            if (!(error instanceof DomainValidationError)) throw error;
            const details =
              Object.keys(error.details).length === 0
                ? ''
                : ` Details: ${JSON.stringify(error.details)}`;
            issueContext.addIssue({ code: 'custom', message: `${error.message}${details}` });
            return z.NEVER;
          }
        });
  const schema = z.preprocess(
    (value) => canonicalizeCodeOwnedFields(value, input.context.manifest.id, evidence),
    validatedSchema
  ) as z.ZodType<Value>;
  const generation = await input.gateway.generateObject({
    schema,
    attemptWarnings: artifactReviewWarningCodes,
    messages: prompt.messages,
    operation: input.operation,
    limits: input.context.generation.limits,
    durableAttempt: input.context.generation.durableAttempt,
    ...(input.context.generation.budget === undefined
      ? {}
      : { budget: input.context.generation.budget }),
    context: {
      instructions: prompt.instructions,
      currentTask: prompt.currentTask,
      evidence: [...prompt.evidence, ...prompt.artifacts]
    }
  });
  return { value: generation.value, evidence: prompt.evidenceRecords };
}
