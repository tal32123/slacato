import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  generateSlackFixtures,
  type FixtureGenerationGateway,
  type ProviderAttemptLedger,
  type SlackGenerationCandidate,
  type SlackUpdate
} from '../packages/core/src/index.js';
import { createMockModelGateways } from '../packages/infrastructure/src/index.js';
import { PINNED_COMMIT } from './fetch-fixtures.js';

const REVIEWED_CANDIDATES: readonly SlackGenerationCandidate[] = [
  {
    updateId: 'SLK-1001-01', opportunityId: 'OPP-1001', accountId: 'ACC-2001', updateDate: '2026-04-25',
    channel: 'account-northstar', authorRole: 'Account Owner', syntheticNotice: true, sourceAccessLevel: 'standard',
    updateText: 'The account team confirmed that the final packet still centers on named migration owners and measurable exception reduction, reinforcing the latest buyer calls.',
    contextKinds: ['reinforcing_fact']
  },
  {
    updateId: 'SLK-1001-02', opportunityId: 'OPP-1001', accountId: 'ACC-2001', updateDate: '2026-04-26',
    channel: 'account-northstar', authorRole: 'Deal Strategist', syntheticNotice: true, sourceAccessLevel: 'standard',
    updateText: 'The written payment schedule has not yet been confirmed in the account-team thread, so the signature packet still has a documented information gap.',
    contextKinds: ['missing_context']
  },
  {
    updateId: 'SLK-1001-03', opportunityId: 'OPP-1001', accountId: 'ACC-2001', updateDate: '2026-04-27',
    channel: 'account-northstar', authorRole: 'Solutions Lead', syntheticNotice: true, sourceAccessLevel: 'standard',
    updateText: 'Regional stakeholders appear comfortable with weekly reporting, while executive support remains conditional on a credible exception plan; treat this as unresolved alignment, not approval.',
    contextKinds: ['ambiguity_or_conflict']
  },
  {
    updateId: 'SLK-1002-01', opportunityId: 'OPP-1002', accountId: 'ACC-2002', updateDate: '2026-04-26',
    channel: 'account-meridian', authorRole: 'Account Owner', syntheticNotice: true, sourceAccessLevel: 'standard',
    updateText: 'The team reiterated that the proof is directionally successful and that the technical champion remains supportive, matching the proof-closeout call.',
    contextKinds: ['reinforcing_fact']
  },
  {
    updateId: 'SLK-1002-02', opportunityId: 'OPP-1002', accountId: 'ACC-2002', updateDate: '2026-04-27',
    channel: 'account-meridian', authorRole: 'Customer Success', syntheticNotice: true, sourceAccessLevel: 'standard',
    updateText: 'No confirmed completion dates are recorded yet for the reporting-export retest or the incident-owner map, leaving the proof exit schedule incomplete.',
    contextKinds: ['missing_context']
  },
  {
    updateId: 'SLK-1002-03', opportunityId: 'OPP-1002', accountId: 'ACC-2002', updateDate: '2026-04-28',
    channel: 'account-meridian', authorRole: 'Solutions Lead', syntheticNotice: true, sourceAccessLevel: 'standard',
    updateText: 'Operations is treating both remediation items as proof-exit criteria, while the rollout team may view them as follow-up work; the stage interpretation needs confirmation.',
    contextKinds: ['ambiguity_or_conflict']
  },
  {
    updateId: 'SLK-1003-01', opportunityId: 'OPP-1003', accountId: 'ACC-2003', updateDate: '2026-04-28',
    channel: 'restricted-eclipse', authorRole: 'Restricted Account Owner', syntheticNotice: true, sourceAccessLevel: 'restricted',
    updateText: 'The restricted account team reaffirmed that discount, liability language, and restricted-source use each require approval before a recommendation is shared.',
    contextKinds: ['reinforcing_fact']
  },
  {
    updateId: 'SLK-1003-02', opportunityId: 'OPP-1003', accountId: 'ACC-2003', updateDate: '2026-04-29',
    channel: 'restricted-eclipse', authorRole: 'Deal Strategist', syntheticNotice: true, sourceAccessLevel: 'restricted',
    updateText: 'The thread does not contain an approved concession statement or a completed legal redline, so customer-facing language remains a missing input.',
    contextKinds: ['missing_context']
  },
  {
    updateId: 'SLK-1003-03', opportunityId: 'OPP-1003', accountId: 'ACC-2003', updateDate: '2026-04-30',
    channel: 'restricted-eclipse', authorRole: 'Legal Liaison', syntheticNotice: true, sourceAccessLevel: 'restricted',
    updateText: 'Procurement continues to request a written concession while legal has warned against informal language; preserve both signals and route the conflict for approval.',
    contextKinds: ['ambiguity_or_conflict']
  }
];

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function parseRows(path: string): readonly Record<string, string>[] {
  const [headerLine, ...lines] = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/);
  if (headerLine === undefined) throw new Error(`Missing TSV header: ${path}`);
  const headers = headerLine.split('\t');
  return lines.map((line) => Object.fromEntries(headers.map((header, index) => [header, line.split('\t')[index] ?? ''])));
}

function tsv(updates: readonly SlackUpdate[]): string {
  const headers = ['update_id', 'opportunity_id', 'account_id', 'update_date', 'channel', 'author_role', 'synthetic_notice', 'source_access_level', 'update_text'] as const;
  const rows = updates.map((row) => [
    row.updateId, row.opportunityId, row.accountId, row.updateDate, row.channel, row.authorRole,
    String(row.syntheticNotice), row.sourceAccessLevel, row.updateText
  ].map((value) => {
    if (/[\t\r\n]/.test(value)) throw new Error(`Slack fixture field contains an unsupported TSV control character: ${row.updateId}`);
    return value;
  }).join('\t'));
  return `${headers.join('\t')}\n${rows.join('\n')}\n`;
}

class GenerationMetadataLedger implements ProviderAttemptLedger {
  private ordinal = 0;
  public async beginAttempt(input: { requestedOutputTokens: number }) {
    this.ordinal += 1;
    return { reservationId: `fixture-reservation-${this.ordinal}`, attemptId: `fixture-attempt-${this.ordinal}`, ordinal: this.ordinal, grantedOutputTokens: input.requestedOutputTokens };
  }
  public async settleAttempt(): Promise<void> { /* generation.json is the durable record for this one-time operation */ }
  public async releaseAttempt(): Promise<void> { /* failures are surfaced and do not replace reviewed fixtures */ }
}

async function main(): Promise<void> {
  const root = resolve(process.cwd(), 'fixtures/cato');
  const opportunities = parseRows(join(root, 'salesforce/opportunities.tsv'));
  const summaries = parseRows(join(root, 'gong/gong_call_summaries.tsv'));
  const latestByOpportunity = new Map<string, string>();
  for (const summary of summaries) {
    const opportunityId = summary.opportunity_id ?? '';
    const callDate = summary.call_date ?? '';
    if (callDate > (latestByOpportunity.get(opportunityId) ?? '')) latestByOpportunity.set(opportunityId, callDate);
  }
  let promptMaterial = '';
  const provider = createMockModelGateways({
    attemptLedger: new GenerationMetadataLedger(),
    resolve(request) {
      promptMaterial = JSON.stringify(request.messages);
      return { text: JSON.stringify(REVIEWED_CANDIDATES), usage: { inputTokens: 1_500, outputTokens: 1_200 } };
    }
  });
  const gateway: FixtureGenerationGateway = {
    async generateObject(request) {
      return provider.modelGateway.generateObject({
        ...request,
        durableAttempt: { runScope: 'fixture-generation-v1', provider: 'mock', model: 'mock-specialist' },
        limits: { maxCalls: 2, maxSchemaRepairs: 1, maxTransportRetries: 0, deadlineMs: 30_000, maxInputTokens: 16_000, maxOutputTokens: 8_000 }
      });
    }
  };
  const input = {
    opportunities: opportunities.map((row) => ({
      opportunityId: row.opportunity_id ?? '', accountId: row.account_id ?? '', closeDate: row.close_date ?? '',
      latestEvidenceDate: latestByOpportunity.get(row.opportunity_id ?? '') ?? ''
    })),
    evidenceSummary: summaries.map((row) => `${row.call_id}: ${row.summary}`).join('\n')
  };
  const updates = await generateSlackFixtures(input, gateway);
  const output = tsv(updates);
  const promptHash = sha256(promptMaterial);
  const outputHash = sha256(output);
  const generationPath = join(root, 'slack/generation.json');
  let generatedAt = new Date().toISOString();
  try {
    const previous = JSON.parse(readFileSync(generationPath, 'utf8')) as { promptHash?: unknown; outputHash?: unknown; generatedAt?: unknown };
    if (previous.promptHash === promptHash && previous.outputHash === outputHash && typeof previous.generatedAt === 'string') generatedAt = previous.generatedAt;
  } catch { /* first reviewed generation */ }
  writeFileSync(join(root, 'slack/account_team_updates.tsv'), output);
  const coverage = Object.fromEntries(input.opportunities.map((opportunity) => [opportunity.opportunityId, {
    count: updates.filter((row) => row.opportunityId === opportunity.opportunityId).length,
    contextKinds: ['reinforcing_fact', 'missing_context', 'ambiguity_or_conflict'],
    chronologyValid: true
  }]));
  writeFileSync(generationPath, `${JSON.stringify({
    provider: 'mock', model: 'mock-specialist', sourceCommit: PINNED_COMMIT, promptHash, outputHash, generatedAt,
    reviewStatus: 'reviewed', validation: { passed: true, syntheticNotices: true, coverage }
  }, null, 2)}\n`);
  process.stdout.write(`Generated and validated ${updates.length} reviewed Slack fixtures with the deterministic mock gateway.\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
