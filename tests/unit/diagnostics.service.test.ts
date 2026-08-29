import { describe, expect, it } from 'vitest';
import { HealthService } from '../../apps/api/src/modules/health/health.service';
import { DiagnosticsService } from '../../apps/api/src/modules/diagnostics/diagnostics.service';
import { configuredProviderRuntime } from '../../apps/api/src/main';
import { envSchema } from '@slacato/infrastructure/config/env';
import type {
  ApprovalAuthorityQuery,
  ProviderRuntimeDescriptor
} from '../../apps/api/src/modules/diagnostics/contracts';

const ready = new HealthService({
  database: { isReady: async () => true },
  migration: { isReady: async () => true },
  redis: { isReady: async () => true },
  index: { isReady: async () => true },
  model: { isReady: async () => true }
});

const runtime: ProviderRuntimeDescriptor = {
  provider: 'ollama',
  outputMode: 'native_schema',
  pinnedGenerationModel: 'generation-from-runtime',
  pinnedEmbeddingModel: 'embedding-from-runtime'
};

function session(grants: readonly Readonly<{
  accountId: string;
  sourceType: 'salesforce';
  canRead: boolean;
  canReadRestricted: boolean;
  canRequestApproval: boolean;
  canApprove: boolean;
  sensitivePricing: boolean;
}>[] = []) {
  return {
    claims: {
      userId: 'USR-5006',
      issuedAt: 1,
      version: '8efc42aa-89b4-42f1-91cc-cb3807cae361'
    },
    persona: {
      userId: 'USR-5006',
      displayName: 'Iris Wynn',
      role: 'Legal Reviewer',
      grants
    }
  };
}

describe('DiagnosticsService', () => {
  it('shows canonical account authority even when the persona has no evidence grants', async () => {
    const requestedPersonas: string[] = [];
    const authorities: ApprovalAuthorityQuery = {
      forPersona: async (personaId) => {
        requestedPersonas.push(personaId);
        return [{ accountId: 'ACC-2003', authorities: ['legal_reviewer'] }];
      }
    };
    const result = await new DiagnosticsService(ready, runtime, authorities).view(session());

    expect(requestedPersonas).toEqual(['USR-5006']);
    expect(result.permissions).toEqual([]);
    expect(result.approvalAuthorities).toEqual([
      { accountId: 'ACC-2003', authorities: ['legal_reviewer'] }
    ]);
  });

  it('projects source permissions without deriving decision authority from role or evidence grants', async () => {
    const authorities: ApprovalAuthorityQuery = { forPersona: async () => [] };
    const result = await new DiagnosticsService(ready, runtime, authorities).view(session([{
      accountId: 'ACC-2003',
      sourceType: 'salesforce',
      canRead: true,
      canReadRestricted: false,
      canRequestApproval: true,
      canApprove: true,
      sensitivePricing: false
    }]));

    expect(result.permissions).toEqual([{
      accountId: 'ACC-2003',
      sourceType: 'salesforce',
      canRead: true,
      restrictedOpportunityAccess: false,
      sensitivePricing: false,
      canRequestApproval: true
    }]);
    expect(result.providerHealth).toMatchObject(runtime);
  });
});

describe('configuredProviderRuntime', () => {
  it('constructs the provider facts at composition instead of requiring service policy', () => {
    const environment = envSchema.parse({
      AI_PROVIDER: 'openrouter',
      DATABASE_URL: 'postgres://localhost:5432/slacato',
      SESSION_SECRET: '12345678901234567890123456789012',
      OPENROUTER_API_KEY: 'server-secret',
      OPENROUTER_CHAT_MODEL: 'generation-from-config',
      OPENROUTER_EMBEDDING_MODEL: 'embedding-from-config'
    });

    expect(configuredProviderRuntime(environment)).toEqual({
      provider: 'openrouter',
      outputMode: 'native_schema',
      pinnedGenerationModel: 'generation-from-config',
      pinnedEmbeddingModel: 'embedding-from-config'
    });
  });
});
