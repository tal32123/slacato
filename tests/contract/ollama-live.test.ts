import { describe, expect, it } from 'vitest';
import {
  commercialArtifactSchema,
  conversationArtifactSchema,
  stakeholderArtifactSchema,
  strategyArtifactSchema
} from '@slacato/core';
import {
  createOllamaModelGateways,
  probeOllamaCapabilities
} from '@slacato/infrastructure';
import type { ProviderAttemptLedger } from '@slacato/core';

const runLive = process.env.LIVE_AI === '1';
const probeLedger: ProviderAttemptLedger = {
  async beginAttempt() { return { reservationId: crypto.randomUUID(), attemptId: crypto.randomUUID(), ordinal: 1, grantedOutputTokens: 1_024 }; },
  async settleAttempt() {}, async releaseAttempt() {}
};

describe.runIf(runLive)('Ollama Cloud live compatibility', () => {
  it('probes configured chat and embedding models, then validates all agent schemas', async () => {
    const apiKey = process.env.OLLAMA_API_KEY;
    const generationModelId = process.env.OLLAMA_CHAT_MODEL;
    const embeddingModelId = process.env.OLLAMA_EMBEDDING_MODEL;
    if (apiKey === undefined || generationModelId === undefined || embeddingModelId === undefined) {
      throw new Error('LIVE_AI=1 requires OLLAMA_API_KEY, OLLAMA_CHAT_MODEL, and OLLAMA_EMBEDDING_MODEL; live compatibility is not verified.');
    }
    const config = {
      apiKey,
      generationModelId,
      embeddingModelId,
      baseURL: process.env.OLLAMA_BASE_URL ?? 'https://ollama.com/api',
      attemptLedger: probeLedger
    };
    const capability = await probeOllamaCapabilities(config);
    expect(capability.availableModelIds).toContain(generationModelId);
    expect(capability.availableModelIds).toContain(embeddingModelId);
    expect(capability.embeddingDimension).toBeGreaterThan(0);

    const { modelGateway, embeddingGateway } = createOllamaModelGateways(config, capability);
    expect((await embeddingGateway.embed(['SlaCato live embedding check']))[0]?.length).toBe(capability.embeddingDimension);

    const outputs = [
      [conversationArtifactSchema, '{"evidenceManifestId":"manifest_live","goals":[],"concerns":[],"commitments":[],"objections":[],"missingContext":[],"claims":[],"reviewWarnings":[]}'],
      [stakeholderArtifactSchema, '{"evidenceManifestId":"manifest_live","stakeholders":[],"coverageGaps":[],"claims":[],"reviewWarnings":[]}'],
      [commercialArtifactSchema, '{"evidenceManifestId":"manifest_live","commercialTerms":[],"policyTriggers":[],"claims":[],"reviewWarnings":[]}'],
      [strategyArtifactSchema, '{"dealSnapshot":{"accountName":"Live","opportunityName":"Live","stage":"Open"},"executiveSummary":{"narrative":"Live"},"buyerGoalsAndBusinessDrivers":{"goals":[],"businessDrivers":[]},"stakeholderMap":{"stakeholders":[]},"negotiationState":{"currentState":"Live","risks":[]},"recommendedNextActions":{"actions":[]},"missingInformation":{"items":[]},"sourceEvidence":{"evidence":[]},"confidenceAndReviewWarnings":{"overallConfidence":0,"warnings":[]}}']
    ] as const;
    for (const [schema, exactJson] of outputs) {
      const result = await modelGateway.generateObject({
        schema,
        messages: [{ role: 'user', content: `Return this exact JSON and no other content: ${exactJson}` }],
        operation: 'ollama-live-schema',
        durableAttempt: { runScope: 'live-probe', provider: 'ollama', model: generationModelId },
        limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 30_000, maxInputTokens: 32_000, maxOutputTokens: 1_024 }
      });
      expect(result.outputMode).toBe(capability.nativeStructuredOutput ? 'native_schema' : 'prompted_json');
      expect(result.attempts.length).toBeLessThanOrEqual(2);
    }
  }, 180_000);
});

describe.skipIf(runLive)('Ollama Cloud live compatibility', () => {
  it('is opt-in; no credential-free success is reported', () => {
    expect(process.env.LIVE_AI).not.toBe('1');
  });
});
