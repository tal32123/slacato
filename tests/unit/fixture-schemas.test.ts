import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSlackCoverage,
  classifyEvidenceSensitivity,
  parseFixtureSet,
  slackUpdatesSchema,
  type OpportunityFixture,
  type PolicyFixture
} from '@slacato/core';

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
      const changedSlack = readFileSync(slackPath, 'utf8').replace('2026-04-25', '2026-04-01');
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
});
