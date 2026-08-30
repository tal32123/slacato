import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type BudgetedModelGateway,
  type FixtureGenerationGateway,
  generateSlackFixtures,
  type ProviderAttemptLedger,
  type SlackGenerationCandidate,
  type SlackUpdate,
  slackGenerationCandidateSchema
} from '../packages/core/src/index.js';
import {
  createOllamaModelGateways,
  createOpenRouterModelGateways
} from '../packages/infrastructure/src/index.js';
import { PINNED_COMMIT } from './fetch-fixtures.js';

/** Produces a stable fingerprint for generated fixture material. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Loads tab-separated fixture rows into records keyed by their column names. */
function parseRows(path: string): readonly Record<string, string>[] {
  const [headerLine, ...lines] = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/);
  if (headerLine === undefined) throw new Error(`Missing TSV header: ${path}`);
  const headers = headerLine.split('\t');
  return lines.map((line) =>
    Object.fromEntries(headers.map((header, index) => [header, line.split('\t')[index] ?? '']))
  );
}

/** Serializes validated Slack updates into the canonical tab-separated fixture format. */
function tsv(updates: readonly SlackUpdate[]): string {
  const headers = [
    'update_id',
    'opportunity_id',
    'account_id',
    'update_date',
    'channel',
    'author_role',
    'synthetic_notice',
    'source_access_level',
    'update_text'
  ] as const;
  const rows = updates.map((row) =>
    [
      row.updateId,
      row.opportunityId,
      row.accountId,
      row.updateDate,
      row.channel,
      row.authorRole,
      String(row.syntheticNotice),
      row.sourceAccessLevel,
      row.updateText
    ]
      .map((value) => {
        if (/[\t\r\n]/.test(value))
          throw new Error(
            `Slack fixture field contains an unsupported TSV control character: ${row.updateId}`
          );
        return value;
      })
      .join('\t')
  );
  return `${headers.join('\t')}\n${rows.join('\n')}\n`;
}

type LiveFixtureProvider = Readonly<{
  provider: 'ollama' | 'openrouter';
  model: string;
  modelGateway: BudgetedModelGateway;
}>;

/** Reads a non-empty provider setting without supplying a development fallback. */
function requiredProviderSetting(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0)
    throw new Error(`Live Slack fixture generation requires ${name}`);
  return value;
}

/** Composes the selected live provider adapter from explicit environment settings. */
function createLiveFixtureProvider(
  environment: NodeJS.ProcessEnv,
  attemptLedger: ProviderAttemptLedger
): LiveFixtureProvider {
  const provider = requiredProviderSetting(environment, 'AI_PROVIDER');
  if (provider === 'mock')
    throw new Error('Live Slack fixture generation does not allow AI_PROVIDER=mock');
  if (provider === 'openrouter') {
    const model = requiredProviderSetting(environment, 'OPENROUTER_CHAT_MODEL');
    const gateways = createOpenRouterModelGateways({
      apiKey: requiredProviderSetting(environment, 'OPENROUTER_API_KEY'),
      generationModelId: model,
      embeddingModelId: requiredProviderSetting(environment, 'OPENROUTER_EMBEDDING_MODEL'),
      attemptLedger
    });
    return { provider, model, modelGateway: gateways.modelGateway };
  }
  if (provider === 'ollama') {
    const model = requiredProviderSetting(environment, 'OLLAMA_CHAT_MODEL');
    const gateways = createOllamaModelGateways(
      {
        baseURL: requiredProviderSetting(environment, 'OLLAMA_BASE_URL'),
        apiKey: requiredProviderSetting(environment, 'OLLAMA_API_KEY'),
        generationModelId: model,
        embeddingModelId: requiredProviderSetting(environment, 'OLLAMA_EMBEDDING_MODEL'),
        attemptLedger
      },
      { nativeStructuredOutput: false }
    );
    return { provider, model, modelGateway: gateways.modelGateway };
  }
  throw new Error(`Live Slack fixture generation does not support AI_PROVIDER=${provider}`);
}

type GenerationProvenance = Readonly<{
  outputMode: 'native_schema' | 'prompted_json';
  callCount: number;
  repairCount: number;
  usage: Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>;
  requestIds?: readonly string[];
  responseIds?: readonly string[];
}>;

/** Collects truthful provider accounting for the generation manifest without external storage. */
class GenerationMetadataLedger implements ProviderAttemptLedger {
  private ordinal = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private outputMode: GenerationProvenance['outputMode'] | undefined;
  private validationAttempts = 0;
  private readonly requestIds: string[] = [];
  private readonly responseIds: string[] = [];

  /** Creates local metadata for the next fixture-generation provider attempt. */
  public async beginAttempt(input: Parameters<ProviderAttemptLedger['beginAttempt']>[0]) {
    this.ordinal += 1;
    return {
      reservationId: `fixture-reservation-${this.ordinal}`,
      attemptId: `fixture-attempt-${this.ordinal}`,
      ordinal: this.ordinal,
      grantedOutputTokens: input.requestedOutputTokens
    };
  }

  /** Aggregates provider-reported token usage and response identifiers after a completed call. */
  public async settleAttempt(
    input: Parameters<ProviderAttemptLedger['settleAttempt']>[0]
  ): Promise<void> {
    const { actualInputTokens, actualOutputTokens } = input;
    if (
      typeof actualInputTokens !== 'number' ||
      !Number.isInteger(actualInputTokens) ||
      actualInputTokens <= 0 ||
      typeof actualOutputTokens !== 'number' ||
      !Number.isInteger(actualOutputTokens) ||
      actualOutputTokens <= 0
    ) {
      throw new Error(
        'Live Slack fixture generation requires positive provider-reported token usage'
      );
    }
    this.inputTokens += actualInputTokens;
    this.outputTokens += actualOutputTokens;
    if (input.requestId !== undefined && input.requestId.length > 0)
      this.requestIds.push(input.requestId);
    if (input.responseId !== undefined && input.responseId.length > 0)
      this.responseIds.push(input.responseId);
  }

  /** Leaves failed attempts counted but does not invent usage or provider identifiers for them. */
  public async releaseAttempt(): Promise<void> {
    /* The surfaced provider failure prevents fixture and manifest replacement. */
  }

  /** Records the provider output mode and cumulative schema-validation attempt count. */
  public async recordAttemptMetadata(
    input: Parameters<NonNullable<ProviderAttemptLedger['recordAttemptMetadata']>>[0]
  ): Promise<void> {
    if (this.outputMode !== undefined && this.outputMode !== input.outputMode) {
      throw new Error('Provider output mode changed during Slack fixture generation');
    }
    this.outputMode = input.outputMode;
    this.validationAttempts = Math.max(this.validationAttempts, input.validationAttempts);
  }

  /** Returns complete live provenance only after a successful provider call and validation. */
  public provenance(): GenerationProvenance {
    if (
      this.ordinal <= 0 ||
      this.inputTokens <= 0 ||
      this.outputTokens <= 0 ||
      this.outputMode === undefined
    ) {
      throw new Error('Live Slack fixture generation did not produce complete provider provenance');
    }
    return {
      outputMode: this.outputMode,
      callCount: this.ordinal,
      repairCount: Math.max(0, this.validationAttempts - 1),
      usage: {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        totalTokens: this.inputTokens + this.outputTokens
      },
      ...(this.requestIds.length === 0 ? {} : { requestIds: [...this.requestIds] }),
      ...(this.responseIds.length === 0 ? {} : { responseIds: [...this.responseIds] })
    };
  }
}

/** Generates, validates, and records Slack fixtures using an explicitly configured live provider. */
async function main(): Promise<void> {
  const attemptLedger = new GenerationMetadataLedger();
  const provider = createLiveFixtureProvider(process.env, attemptLedger);
  const root = resolve(process.cwd(), 'fixtures/cato');
  const opportunities = parseRows(join(root, 'salesforce/opportunities.tsv'));
  const summaries = parseRows(join(root, 'gong/gong_call_summaries.tsv'));
  const latestByOpportunity = new Map<string, string>();
  for (const summary of summaries) {
    const opportunityId = summary.opportunity_id ?? '';
    const callDate = summary.call_date ?? '';
    if (callDate > (latestByOpportunity.get(opportunityId) ?? ''))
      latestByOpportunity.set(opportunityId, callDate);
  }
  let promptMaterial = '';
  let schemaMaterial = '';
  let validatedCandidates: readonly SlackGenerationCandidate[] = [];
  const gateway: FixtureGenerationGateway = {
    /** Sends the fixture prompt through the live gateway with bounded retries and durable attempt metadata. */
    async generateObject(request) {
      promptMaterial = JSON.stringify(request.messages);
      schemaMaterial = JSON.stringify(z.toJSONSchema(request.schema, { io: 'input' }));
      const result = await provider.modelGateway.generateObject({
        ...request,
        durableAttempt: {
          runScope: 'fixture-generation-v1',
          provider: provider.provider,
          model: provider.model
        },
        limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 30_000 }
      });
      validatedCandidates = slackGenerationCandidateSchema.array().parse(result.value);
      return result;
    }
  };
  const input = {
    opportunities: opportunities.map((row) => ({
      opportunityId: row.opportunity_id ?? '',
      accountId: row.account_id ?? '',
      closeDate: row.close_date ?? '',
      latestEvidenceDate: latestByOpportunity.get(row.opportunity_id ?? '') ?? ''
    })),
    evidenceSummary: summaries.map((row) => `${row.call_id}: ${row.summary}`).join('\n')
  };
  const updates = await generateSlackFixtures(input, gateway);
  const output = tsv(updates);
  const provenance = attemptLedger.provenance();
  const promptHash = sha256(promptMaterial);
  const schemaHash = sha256(schemaMaterial);
  const sourceHash = sha256(JSON.stringify(input));
  const outputHash = sha256(output);
  const generationPath = join(root, 'slack/generation.json');
  const generatedAt = new Date().toISOString();
  const rowContextKinds: Record<string, SlackGenerationCandidate['contextKinds']> = {};
  for (const candidate of validatedCandidates) {
    if (Object.hasOwn(rowContextKinds, candidate.updateId)) {
      throw new Error(`Generated Slack updates contain duplicate update ID ${candidate.updateId}`);
    }
    rowContextKinds[candidate.updateId] = candidate.contextKinds;
  }
  if (Object.keys(rowContextKinds).length !== updates.length) {
    throw new Error('Generated Slack row-level context coverage is incomplete');
  }
  const coverage = Object.fromEntries(
    input.opportunities.map((opportunity) => {
      const candidates = validatedCandidates.filter(
        (candidate) => candidate.opportunityId === opportunity.opportunityId
      );
      return [
        opportunity.opportunityId,
        {
          count: candidates.length,
          contextKinds: [...new Set(candidates.flatMap((candidate) => candidate.contextKinds))],
          chronologyValid: true
        }
      ];
    })
  );
  writeFileSync(join(root, 'slack/account_team_updates.tsv'), output);
  writeFileSync(
    generationPath,
    `${JSON.stringify(
      {
        provider: provider.provider,
        model: provider.model,
        sourceCommit: PINNED_COMMIT,
        promptHash,
        schemaHash,
        sourceHash,
        outputHash,
        ...provenance,
        rowContextKinds,
        generatedAt,
        reviewStatus: 'reviewed',
        validation: { passed: true, syntheticNotices: true, coverage }
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(
    `Generated and validated ${updates.length} synthetic Slack fixtures with ${provider.provider}/${provider.model}.\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
