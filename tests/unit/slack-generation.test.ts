import { describe, expect, it } from 'vitest';
import { generateSlackFixtures, type FixtureGenerationGateway, type SlackGenerationCandidate } from '@slacato/core';

const candidates: SlackGenerationCandidate[] = [
  {
    updateId: 'SLK-1001-A', opportunityId: 'OPP-1001', accountId: 'ACC-2001', updateDate: '2026-04-26',
    channel: 'account-northstar', authorRole: 'Account Owner', syntheticNotice: true, sourceAccessLevel: 'standard',
    updateText: 'The owner matrix now has named leads, but regional sign-off remains unclear.',
    contextKinds: ['reinforcing_fact', 'ambiguity_or_conflict']
  },
  {
    updateId: 'SLK-1001-B', opportunityId: 'OPP-1001', accountId: 'ACC-2001', updateDate: '2026-04-27',
    channel: 'account-northstar', authorRole: 'Solutions Lead', syntheticNotice: true, sourceAccessLevel: 'standard',
    updateText: 'The team still needs a confirmed payment schedule before the signature packet.',
    contextKinds: ['missing_context']
  }
];

describe('Slack fixture generation', () => {
  it('accepts only validated coverage from the provider-neutral gateway', async () => {
    const gateway: FixtureGenerationGateway = {
      async generateObject<Value>(request) {
        return { value: request.schema.parse(candidates) as Value };
      }
    };

    const updates = await generateSlackFixtures({
      opportunities: [{ opportunityId: 'OPP-1001', accountId: 'ACC-2001', closeDate: '2026-05-17', latestEvidenceDate: '2026-04-25' }],
      evidenceSummary: 'Reviewed canonical summary'
    }, gateway);

    expect(updates).toHaveLength(2);
    expect(updates.every((row) => row.syntheticNotice)).toBe(true);
    expect(updates[0]).not.toHaveProperty('contextKinds');
  });

  it('rejects generated rows that omit ambiguity coverage', async () => {
    const gateway: FixtureGenerationGateway = {
      async generateObject<Value>(request) {
        const incomplete = candidates.map((row) => ({ ...row, contextKinds: row.contextKinds.filter((kind) => kind !== 'ambiguity_or_conflict') }));
        return { value: request.schema.parse(incomplete) as Value };
      }
    };

    await expect(generateSlackFixtures({
      opportunities: [{ opportunityId: 'OPP-1001', accountId: 'ACC-2001', closeDate: '2026-05-17', latestEvidenceDate: '2026-04-25' }],
      evidenceSummary: 'Reviewed canonical summary'
    }, gateway)).rejects.toThrow(/ambiguity_or_conflict/);
  });
});
