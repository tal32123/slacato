import { describe, expect, it } from 'vitest';
import { buildEvidenceDocuments, chunkDocument, parseFixtureSet, POLICY_CHUNK_CHARACTERS, type EvidenceDocument } from '@slacato/core';

const base = {
  externalId: 'CALL-001',
  sourceType: 'gong_transcript',
  accountId: 'ACC-2001',
  opportunityId: 'OPP-1001',
  eventDate: '2026-03-11',
  accessLevel: 'standard',
  reliability: 'direct_conversation',
  classificationReason: 'source_declared_standard',
  policyHash: 'policy-hash',
  sourceLocator: 'gong/transcripts/OPP-1001_CALL-001.md'
} as const;

describe('deterministic evidence chunking', () => {
  it('chunks a structured record as one stable, metadata-rich unit', () => {
    const document: EvidenceDocument = { ...base, sourceType: 'salesforce', externalId: 'OPP-1001', content: 'Stage: Order Review\nACV: 4217500' };

    expect(chunkDocument(document)).toEqual([{
      id: 'salesforce:OPP-1001:0',
      documentExternalId: 'OPP-1001',
      chunkIndex: 0,
      content: 'Stage: Order Review\nACV: 4217500',
      accountId: 'ACC-2001',
      opportunityId: 'OPP-1001',
      sourceType: 'salesforce',
      accessLevel: 'standard',
      eventDate: '2026-03-11',
      reliability: 'direct_conversation',
      classificationReason: 'source_declared_standard',
      policyHash: 'policy-hash',
      sourceLocator: 'gong/transcripts/OPP-1001_CALL-001.md#chunk-0'
    }]);
  });

  it('uses overlapping speaker windows without changing stable IDs', () => {
    const turns = Array.from({ length: 9 }, (_, index) => `Speaker ${index + 1}: Turn ${index + 1}`).join('\n\n');
    const transcriptHeader = '# Transcript\n\n**Opportunity:** OPP-1001\n**Account:** ACC-2001\n**Date:** 2026-03-11\n**Source access level:** standard';
    const document: EvidenceDocument = { ...base, content: `${transcriptHeader}\n\n${turns}` };

    const first = chunkDocument(document);
    const second = chunkDocument(document);

    expect(first).toEqual(second);
    expect(first.map((chunk) => chunk.id)).toEqual([
      'gong_transcript:CALL-001:0',
      'gong_transcript:CALL-001:1'
    ]);
    expect(first.map((chunk) => chunk.content.startsWith(`${transcriptHeader}\n\n`))).toEqual([true, true]);
    expect(first[0]?.content).toContain('Speaker 6: Turn 6');
    expect(first[1]?.content).toContain('Speaker 6: Turn 6');
  });

  it('chunks policy Markdown at headings', () => {
    const chunks = chunkDocument({
      ...base,
      sourceType: 'policy',
      externalId: 'deal-desk-policy',
      reliability: 'authoritative_policy',
      content: '# Policy\nIntro\n\n## Approval Rules\n1. Approval is required.\n\n## Access Rules\n1. Deny by default.'
    });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      '# Policy\nIntro',
      '## Approval Rules\n1. Approval is required.',
      '## Access Rules\n1. Deny by default.'
    ]);
    expect(chunks.map((chunk) => chunk.id)).toEqual([
      'policy:deal-desk-policy:0',
      'policy:deal-desk-policy:1',
      'policy:deal-desk-policy:2'
    ]);
  });

  it('splits an oversized policy section into heading-anchored chunks that stay quotable', () => {
    const rules = Array.from({ length: 12 }, (_, index) => `${index + 1}. Approval rule ${index + 1} states a requirement in enough words to fill a line.`);
    const chunks = chunkDocument({
      ...base,
      sourceType: 'policy',
      externalId: 'deal-desk-policy',
      reliability: 'authoritative_policy',
      content: `## Approval Rules\n${rules.join('\n')}`
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= POLICY_CHUNK_CHARACTERS)).toBe(true);
    expect(chunks.every((chunk) => chunk.content.startsWith('## Approval Rules\n'))).toBe(true);
    expect(rules.every((rule) => chunks.some((chunk) => chunk.content.includes(rule)))).toBe(true);
  });

  it('keeps every canonical policy rule inside a chunk retrieval can quote whole', () => {
    const policy = buildEvidenceDocuments(parseFixtureSet('fixtures/cato')).find((document) => document.sourceType === 'policy');
    if (policy === undefined) throw new Error('Canonical fixtures are missing the deal desk policy');
    const chunks = chunkDocument(policy);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= POLICY_CHUNK_CHARACTERS)).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes('10. If source access is denied, the system must not reveal a summary'))).toBe(true);
  });

  it('builds classified canonical documents without embeddings', () => {
    const fixtures = parseFixtureSet('fixtures/cato');
    const documents = buildEvidenceDocuments(fixtures);
    const pricing = documents.filter((document) => document.sourceType === 'pricing');

    expect(documents).toHaveLength(74);
    expect(pricing).toHaveLength(5);
    expect(pricing.map(({ externalId, accessLevel, classificationReason }) => ({
      externalId,
      accessLevel,
      classificationReason
    }))).toEqual([
      { externalId: 'PN-4001', accessLevel: 'standard', classificationReason: 'policy_non_sensitive_pricing' },
      { externalId: 'PN-4002', accessLevel: 'standard', classificationReason: 'policy_non_sensitive_pricing' },
      { externalId: 'PN-4003', accessLevel: 'standard', classificationReason: 'policy_non_sensitive_pricing' },
      { externalId: 'PN-4004', accessLevel: 'restricted', classificationReason: 'policy_sensitive_pricing' },
      { externalId: 'PN-4005', accessLevel: 'restricted', classificationReason: 'policy_sensitive_pricing' }
    ]);
    expect(documents.every((document) => document.policyHash === fixtures.policy.contentHash)).toBe(true);
    expect(documents.every((document) => document.opportunityId !== undefined)).toBe(true);
    expect(JSON.stringify(documents)).not.toContain('embedding');
  });

  it('duplicates account-wide evidence deterministically for every account opportunity', () => {
    const fixtures = parseFixtureSet('fixtures/cato');
    const firstOpportunity = fixtures.opportunities[0]!;
    const secondOpportunity = { ...firstOpportunity, opportunityId: 'OPP-1999', opportunityName: 'Second account opportunity' };
    const documents = buildEvidenceDocuments({ ...fixtures, opportunities: [...fixtures.opportunities, secondOpportunity] });

    expect(documents.filter((document) => document.sourceLocator.startsWith('salesforce/accounts.tsv#ACC-2001'))
      .map((document) => [document.externalId, document.opportunityId])).toEqual([
        ['ACC-2001:OPP-1001:account', 'OPP-1001'],
        ['ACC-2001:OPP-1999:account', 'OPP-1999']
      ]);
    expect(documents.filter((document) => document.sourceLocator.startsWith('salesforce/contacts.tsv#CON-3001'))
      .map((document) => document.opportunityId)).toEqual(['OPP-1001', 'OPP-1999']);
    expect(documents.filter((document) => document.sourceType === 'policy' && document.accountId === 'ACC-2001')
      .map((document) => document.opportunityId)).toEqual(['OPP-1001', 'OPP-1999']);
  });
});
