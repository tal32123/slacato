import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSlackCoverage,
  classifyEvidenceSensitivity,
  opportunityFixtureSchema,
  slackUpdatesSchema,
  type OpportunityFixture,
  type PolicyFixture
} from '@slacato/core';
import { parseFixtureSet } from '../../scripts/fixture-loader.js';

const opportunities = ['OPP-1001', 'OPP-1002', 'OPP-1003'] as const;

function rewriteAttributedSource(root: string, path: string, content: string): void {
  writeFileSync(join(root, path), content);
  const attributionPath = join(root, 'source-attribution.json');
  const attribution = JSON.parse(readFileSync(attributionPath, 'utf8')) as { files: Array<{ path: string; sha256: string }> };
  attribution.files = attribution.files.map((file) => file.path === path
    ? { ...file, sha256: createHash('sha256').update(content).digest('hex') }
    : file);
  writeFileSync(attributionPath, JSON.stringify(attribution));
}

function slackRow(opportunityId: (typeof opportunities)[number], updateId: string) {
  const accountId = `ACC-${Number(opportunityId.slice(-4)) + 1000}`;
  return {
    updateId,
    opportunityId,
    accountId,
    updateDate: '2026-04-29',
    channel: 'account-team',
    authorRole: 'Account Owner',
    syntheticNotice: true,
    sourceAccessLevel: opportunityId === 'OPP-1003' ? 'restricted' : 'standard',
    updateText: 'Synthetic account-team context for the reviewed fixture.'
  } as const;
}

describe('canonical fixture schemas', () => {
  it('requires at least two clearly synthetic Slack updates for every opportunity', () => {
    const rows = slackUpdatesSchema.parse(opportunities.flatMap((opportunityId, index) => [
      slackRow(opportunityId, `SLK-${index + 1}-A`),
      slackRow(opportunityId, `SLK-${index + 1}-B`)
    ]));

    expect(assertSlackCoverage(rows, opportunities)).toEqual({
      'OPP-1001': 2,
      'OPP-1002': 2,
      'OPP-1003': 2
    });
  });

  it('rejects a non-synthetic Slack row and incomplete opportunity coverage', () => {
    expect(() => slackUpdatesSchema.parse([{ ...slackRow('OPP-1001', 'SLK-1'), syntheticNotice: false }])).toThrow();
    expect(() => assertSlackCoverage([
      slackRow('OPP-1001', 'SLK-1'),
      slackRow('OPP-1001', 'SLK-2')
    ], opportunities)).toThrow(/OPP-1002/);
  });

  it('fails closed when policy-derived pricing sensitivity cannot be proven', () => {
    const opportunity = {
      opportunityId: 'OPP-1001', accountId: 'ACC-2001', restrictedAccess: false
    } as OpportunityFixture;
    const policy = {
      content: 'Sensitive pricing notes may only be shown to users with `can_view_sensitive_pricing=true`.',
      contentHash: 'policy-sha256'
    } as PolicyFixture;

    expect(classifyEvidenceSensitivity({ sourceType: 'pricing', sourceAccessLevel: undefined }, opportunity, policy)).toEqual({
      accessLevel: 'restricted',
      reason: 'policy_sensitive_pricing',
      policyHash: 'policy-sha256'
    });
    expect(() => classifyEvidenceSensitivity(
      { sourceType: 'pricing', sourceAccessLevel: undefined },
      opportunity,
      { ...policy, content: 'No pricing access rule is present.' }
    )).toThrow(/pricing classification/i);
  });

  it('rejects unknown boolean spellings at the TSV boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'slacato-fixture-parse-'));
    try {
      cpSync('fixtures/cato', root, { recursive: true });
      const permissionPath = join(root, 'policies/access_permissions.tsv');
      const changedPermissions = readFileSync(permissionPath, 'utf8').replace('\ttrue\tfalse\n', '\ttruthy\tfalse\n');
      rewriteAttributedSource(root, 'policies/access_permissions.tsv', changedPermissions);
      expect(() => parseFixtureSet(root)).toThrow(/boolean/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a Slack update that predates the opportunity evidence it follows', () => {
    const root = mkdtempSync(join(tmpdir(), 'slacato-fixture-chronology-'));
    try {
      cpSync('fixtures/cato', root, { recursive: true });
      const slackPath = join(root, 'slack/account_team_updates.tsv');
      const [header, firstRow, ...remainingRows] = readFileSync(slackPath, 'utf8')
        .trimEnd()
        .split(/\r?\n/);
      if (header === undefined || firstRow === undefined)
        throw new Error('Slack chronology fixture is empty');
      const fields = firstRow.split('\t');
      fields[3] = '2020-01-01';
      const changedSlack = `${[header, fields.join('\t'), ...remainingRows].join('\n')}\n`;
      writeFileSync(slackPath, changedSlack);
      const generationPath = join(root, 'slack/generation.json');
      const generation = JSON.parse(readFileSync(generationPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(generationPath, JSON.stringify({ ...generation, outputHash: createHash('sha256').update(changedSlack).digest('hex') }));
      expect(() => parseFixtureSet(root)).toThrow(/chronology/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects Slack fixtures whose reviewed generation hash does not match', () => {
    const root = mkdtempSync(join(tmpdir(), 'slacato-fixture-provenance-'));
    try {
      cpSync('fixtures/cato', root, { recursive: true });
      const generationPath = join(root, 'slack/generation.json');
      const generation = JSON.parse(readFileSync(generationPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(generationPath, JSON.stringify({ ...generation, outputHash: '0'.repeat(64) }));
      expect(() => parseFixtureSet(root)).toThrow(/reviewed Slack fixture hash/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates live provider provenance and row-level context coverage', () => {
    const root = mkdtempSync(join(tmpdir(), 'slacato-fixture-live-provenance-'));
    try {
      cpSync('fixtures/cato', root, { recursive: true });
      const generationPath = join(root, 'slack/generation.json');
      const generation = JSON.parse(readFileSync(generationPath, 'utf8')) as Record<string, unknown>;
      const slackLines = readFileSync(join(root, 'slack/account_team_updates.tsv'), 'utf8').trim().split(/\r?\n/).slice(1);
      const rowContextKinds = Object.fromEntries(slackLines.map((line) => [
        line.split('\t')[0],
        ['reinforcing_fact']
      ]));
      const liveGeneration = {
        ...generation,
        outputMode: 'native_schema',
        callCount: 2,
        repairCount: 1,
        usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 },
        requestIds: ['request-1'],
        responseIds: ['response-1'],
        schemaHash: '1'.repeat(64),
        sourceHash: '2'.repeat(64),
        rowContextKinds
      };
      writeFileSync(generationPath, JSON.stringify(liveGeneration));
      expect(() => parseFixtureSet(root)).not.toThrow();

      writeFileSync(generationPath, JSON.stringify({
        ...liveGeneration,
        usage: { inputTokens: 0, outputTokens: 60, totalTokens: 60 }
      }));
      expect(() => parseFixtureSet(root)).toThrow(/token/i);

      const [firstUpdateId, ...remainingUpdateIds] = Object.keys(rowContextKinds);
      expect(firstUpdateId).toBeDefined();
      writeFileSync(generationPath, JSON.stringify({
        ...liveGeneration,
        rowContextKinds: Object.fromEntries(remainingUpdateIds.map((updateId) => [
          updateId,
          rowContextKinds[updateId]
        ]))
      }));
      expect(() => parseFixtureSet(root)).toThrow(/row-level context/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a canonical source file whose pinned attribution hash does not match', () => {
    const root = mkdtempSync(join(tmpdir(), 'slacato-fixture-source-hash-'));
    try {
      cpSync('fixtures/cato', root, { recursive: true });
      const accountPath = join(root, 'salesforce/accounts.tsv');
      writeFileSync(accountPath, readFileSync(accountPath, 'utf8').replace('Northstar Foods Cooperative', 'Changed Fixture'));
      expect(() => parseFixtureSet(root)).toThrow(/canonical source hash/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hard-binds canonical attribution and Slack generation to the pinned source', () => {
    const root = mkdtempSync(join(tmpdir(), 'slacato-fixture-binding-'));
    try {
      cpSync('fixtures/cato', root, { recursive: true });
      const attributionPath = join(root, 'source-attribution.json');
      const attribution = JSON.parse(readFileSync(attributionPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(attributionPath, JSON.stringify({ ...attribution, repository: 'https://example.com/not-canonical.git' }));
      expect(() => parseFixtureSet(root)).toThrow(/canonical repository/i);

      writeFileSync(attributionPath, JSON.stringify({ ...attribution, commit: '0'.repeat(40) }));
      expect(() => parseFixtureSet(root)).toThrow(/canonical commit/i);

      writeFileSync(attributionPath, JSON.stringify(attribution));
      const generationPath = join(root, 'slack/generation.json');
      const generation = JSON.parse(readFileSync(generationPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(generationPath, JSON.stringify({ ...generation, sourceCommit: '0'.repeat(40) }));
      expect(() => parseFixtureSet(root)).toThrow(/Slack source commit/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects impossible calendar dates instead of allowing Date normalization', () => {
    const valid = opportunityFixtureSchema.parse({
      opportunityId: 'OPP-9001', opportunityName: 'Fixture', accountId: 'ACC-9001', accountName: 'Fixture Account',
      stage: 'Test', type: 'Renewal', region: 'EMEA', country: 'Test', industry: 'Test', owner: 'Owner',
      closeDate: '2024-02-29', acv: 1, tcv: 1, renewalTermMonths: 1, probability: 1, forecastCategory: 'Pipeline',
      nextStep: 'Test', primaryCompetitor: 'None', riskLevel: 'low', approvalRequired: false, restrictedAccess: false
    });
    expect(valid.closeDate).toBe('2024-02-29');
    expect(() => opportunityFixtureSchema.parse({ ...valid, closeDate: '2026-02-29' })).toThrow(/ISO date/i);
  });

  it('rejects cross-account and transcript-summary integrity mismatches', () => {
    const root = mkdtempSync(join(tmpdir(), 'slacato-fixture-crossrefs-'));
    try {
      cpSync('fixtures/cato', root, { recursive: true });
      const opportunityPath = 'salesforce/opportunities.tsv';
      rewriteAttributedSource(root, opportunityPath, readFileSync(join(root, opportunityPath), 'utf8')
        .replace('OPP-1001\tNorthstar Foods Cooperative - Global Access Renewal\tACC-2001\tNorthstar Foods Cooperative',
          'OPP-1001\tNorthstar Foods Cooperative - Global Access Renewal\tACC-2001\tWrong Account Name'));
      expect(() => parseFixtureSet(root)).toThrow(/account name/i);

      cpSync('fixtures/cato', root, { recursive: true });
      const gongPath = 'gong/gong_call_summaries.tsv';
      rewriteAttributedSource(root, gongPath, readFileSync(join(root, gongPath), 'utf8').replace('CON-3001, CON-3002, CON-3004', 'CON-3006'));
      expect(() => parseFixtureSet(root)).toThrow(/participant.*account/i);

      cpSync('fixtures/cato', root, { recursive: true });
      const transcriptPath = 'gong/transcripts/OPP-1001_CALL-001.md';
      rewriteAttributedSource(root, transcriptPath, readFileSync(join(root, transcriptPath), 'utf8').replace('**Date:** 2026-03-11', '**Date:** 2026-03-12'));
      expect(() => parseFixtureSet(root)).toThrow(/transcript.*summary/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects transcript files outside the pinned inventory', () => {
    const root = mkdtempSync(join(tmpdir(), 'slacato-fixture-inventory-'));
    try {
      cpSync('fixtures/cato', root, { recursive: true });
      writeFileSync(join(root, 'gong/transcripts/EXTRA.md'), '# unexpected');
      expect(() => parseFixtureSet(root)).toThrow(/transcript inventory/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
