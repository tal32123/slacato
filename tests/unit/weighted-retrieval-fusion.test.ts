import { describe, expect, it } from 'vitest';
import { buildEvidencePlan, type EmbeddingProfile } from '@slacato/core';
import { PostgresHybridEvidenceRetriever } from '@slacato/infrastructure/retrieval/postgres-retriever';
import type { DatabaseClient } from '@slacato/infrastructure/db/client';

const policyHash = 'a'.repeat(64);
const primaryEvidence = {
  id: 'evidence_primary',
  content: 'primary result',
  content_hash: 'primary-hash',
  source_type: 'slack',
  sensitivity: 'standard',
  event_date: null,
  reliability_class: 'unadjusted',
  source_locator: 'slack/primary',
  classification_reason: 'test',
  policy_hash: policyHash
} as const;
const sectionEvidence = {
  ...primaryEvidence,
  id: 'evidence_section',
  content: 'section result',
  content_hash: 'section-hash',
  source_locator: 'slack/section'
} as const;

function retrievalDatabase(): DatabaseClient {
  let currentLexicalQuery = '';
  let semanticQueryIndex = 0;
  const sqlTag = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const statement = strings.join(' ');
    if (statement.includes('select exists (select 1 from runs')) return [{ valid: true }];
    if (statement.includes('select * from run_evidence_manifests')) return [];
    if (statement.includes('select count(*)::integer as total'))
      return [{ total: 2, matching: 2, source_types: ['slack'], policy_hashes: [policyHash] }];
    if (statement.includes("replace(plainto_tsquery('english'")) {
      currentLexicalQuery = String(values[0]);
      return [];
    }
    if (statement.includes('ts_rank_cd(authorized.lexical_content'))
      return [currentLexicalQuery === 'customer-specific question' ? primaryEvidence : sectionEvidence];
    if (statement.includes('authorized.embedding <=>'))
      return [semanticQueryIndex++ === 0 ? primaryEvidence : sectionEvidence];
    if (statement.includes('select count(distinct account.id)::integer'))
      return [{ account: 0, opportunity: 0, contacts: 0 }];
    return [];
  };
  const transaction = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    if (strings.join(' ').includes('insert into run_evidence_manifests'))
      return [{ id: 'manifest' }];
    return [];
  };
  const sql = Object.assign(sqlTag, {
    begin: async (work: (inner: typeof transaction) => Promise<unknown>) => work(transaction)
  });
  return { sql, db: {}, close: async () => {} } as unknown as DatabaseClient;
}

describe('PostgreSQL weighted retrieval fusion', () => {
  it('uses weight 1 for primary lists and the plan weight for section-query lists', async () => {
    const plan = buildEvidencePlan({ query: 'customer-specific question', limit: 2 });
    const profile: EmbeddingProfile = {
      provider: 'test',
      model: 'test',
      dimension: 1,
      profile: 'test-profile',
      version: 'v1',
      normalization: 'l2'
    };
    const embeddingGateway = {
      async embed(values: readonly string[]): Promise<readonly (readonly number[])[]> {
        return values.map((_, index) => [index + 1]);
      }
    };
    const result = await new PostgresHybridEvidenceRetriever(
      retrievalDatabase(),
      embeddingGateway,
      profile
    ).search({
      query: plan.query,
      accountId: 'account_1',
      opportunityId: 'opportunity_1',
      runId: 'run_1',
      limit: 2,
      scope: {
        personaId: 'persona_1',
        allowed: true,
        accountIds: ['account_1'],
        sourceTypes: ['gong_summary', 'gong_transcript', 'pricing', 'salesforce', 'slack'],
        canViewSensitivePricing: false,
        canRequestApproval: false,
        canApprove: false,
        canViewRestrictedAccounts: false
      }
    });

    expect(result.evidence.map((entry) => entry.evidenceId)).toEqual([
      primaryEvidence.id,
      sectionEvidence.id
    ]);
    expect(result.evidence[0]?.fusionScore).toBeCloseTo(2 / (plan.fusionK + 1), 12);
    expect(result.evidence[1]?.fusionScore).toBeCloseTo(
      (plan.sectionQueries.length * 2 * plan.sectionQueryWeight) / (plan.fusionK + 1),
      12
    );
  });
});
