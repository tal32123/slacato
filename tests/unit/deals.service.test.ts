import { dealListItemSchema } from '@slacato/contracts';
import type { DealQueryRepository, EvidenceCategory } from '@slacato/core';
import { describe, expect, it } from 'vitest';
import { DealsService } from '../../apps/api/src/modules/deals/deals.service';

const opportunity = {
  opportunityId: 'OPP-TEST',
  opportunityName: 'Test opportunity',
  accountId: 'ACC-TEST',
  accountName: 'Test account',
  restricted: false,
  createdAt: new Date('2026-08-29T10:00:00.000Z'),
  recordContent: null,
  latestRun: null
} as const;
const opportunityEvidence = {
  id: 'salesforce:OPP-TEST:0',
  sourceType: 'salesforce',
  sensitivity: 'standard',
  eventDate: null,
  sourceLocator: 'salesforce/opportunities.tsv#OPP-TEST#chunk-0',
  createdAt: new Date('2026-08-29T10:00:00.000Z'),
  content:
    'opportunityId: OPP-TEST\nopportunityName: Test opportunity\naccountName: Test account\nstage: Discovery\nowner: Test Owner\ncloseDate: 2026-09-30\nacv: 1000\nprobability: 25\nriskLevel: low\nnextStep: Confirm discovery by 2026-09-01'
} as const;
const reinforcingSlackEvidence = {
  id: 'slack:SLK-TEST:0',
  sourceType: 'slack',
  sensitivity: 'standard',
  eventDate: '2026-08-28',
  sourceLocator: 'slack/account_team_updates.tsv#SLK-TEST#chunk-0',
  createdAt: '2026-08-28T10:00:00.000Z',
  content:
    'updateId: SLK-TEST\nopportunityId: OPP-TEST\naccountId: ACC-TEST\nupdateDate: 2026-08-28\nupdateText: The account team reaffirmed the documented discovery plan and named owners.'
} as const;
const resolvingSlackEvidence = {
  ...reinforcingSlackEvidence,
  id: 'slack:SLK-RESOLVED:0',
  eventDate: '2026-08-29',
  createdAt: '2026-08-29T10:00:00.000Z',
  sourceLocator: 'slack/account_team_updates.tsv#SLK-RESOLVED#chunk-0',
  content:
    'updateId: SLK-RESOLVED\nopportunityId: OPP-TEST\naccountId: ACC-TEST\nupdateDate: 2026-08-29\nupdateText: The previously missing payment schedule is now confirmed and the information gap is resolved.'
} as const;
const unprovenancedEvidence = {
  ...reinforcingSlackEvidence,
  id: 'slack:legacy-null-provenance:0',
  sourceLocator: null,
  content: 'updateText: private legacy row without a stable source record'
} as const;
const session = {
  claims: { version: 'session-version' },
  persona: {
    userId: 'USR-TEST', displayName: 'Test Owner', role: 'Account Owner',
    grants: [{ accountId: 'ACC-TEST', sourceType: 'salesforce' as const, canRead: true, canReadRestricted: false, canRequestApproval: true, canApprove: false, sensitivePricing: false }]
  }
} as const;

describe('DealsService workspace fan-out', () => {
  it('starts independent run, opportunity, stakeholder, and supplemental reads concurrently', async () => {
    const started: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const repository: DealQueryRepository = {
      listAuthorizedDeals: async () => [opportunity],
      findAuthorizedDeal: async () => opportunity,
      findLatestRun: async () => { started.push('run'); await gate; return undefined; },
      listEvidence: async (_scope, category: EvidenceCategory) => {
        started.push(category);
        await gate;
        return category === 'opportunity' ? [opportunityEvidence] : [];
      }
    };
    const pending = new DealsService({ repository }).getAuthorizedDealWorkspace(session, 'OPP-TEST');
    await Promise.resolve();
    await Promise.resolve();
    const beforeRelease = [...started];
    release();
    await pending;

    expect(beforeRelease.sort()).toEqual(['opportunity', 'run', 'stakeholders', 'supplemental']);
  });

  it('does not fabricate a gap, warning, or action from a reinforcing Slack update', async () => {
    const repository: DealQueryRepository = {
      listAuthorizedDeals: async () => [opportunity],
      findAuthorizedDeal: async () => opportunity,
      findLatestRun: async () => undefined,
      listEvidence: async (_scope, category) => category === 'opportunity'
        ? [opportunityEvidence]
        : category === 'supplemental' ? [reinforcingSlackEvidence] : []
    };
    const workspace = await new DealsService({ repository }).getAuthorizedDealWorkspace({
      ...session,
      persona: {
        ...session.persona,
        grants: [...session.persona.grants, {
          accountId: 'ACC-TEST', sourceType: 'slack' as const, canRead: true, canReadRestricted: false,
          canRequestApproval: true, canApprove: false, sensitivePricing: false
        }]
      }
    }, 'OPP-TEST');

    expect(workspace.brief.sections.missingInformation.accountTeamUpdateImpact).toBe(false);
    expect(workspace.brief.actions.every((action) => !action.accountTeamUpdateImpact)).toBe(true);
    expect(workspace.brief.warnings.every((warning) => !warning.accountTeamUpdateImpact)).toBe(true);
  });

  it('does not infer an unresolved gap from a resolving account-team update', async () => {
    const repository: DealQueryRepository = {
      listAuthorizedDeals: async () => [opportunity],
      findAuthorizedDeal: async () => opportunity,
      findLatestRun: async () => undefined,
      listEvidence: async (_scope, category) => category === 'opportunity'
        ? [opportunityEvidence]
        : category === 'supplemental' ? [resolvingSlackEvidence] : []
    };
    const workspace = await new DealsService({ repository }).getAuthorizedDealWorkspace({
      ...session,
      persona: {
        ...session.persona,
        grants: [...session.persona.grants, {
          accountId: 'ACC-TEST', sourceType: 'slack' as const, canRead: true, canReadRestricted: false,
          canRequestApproval: true, canApprove: false, sensitivePricing: false
        }]
      }
    }, 'OPP-TEST');

    expect(workspace.brief.sections.missingInformation.accountTeamUpdateImpact).toBe(false);
    expect(workspace.brief.actions.every((action) => !action.accountTeamUpdateImpact)).toBe(true);
    expect(workspace.brief.warnings.every((warning) => !warning.accountTeamUpdateImpact)).toBe(true);
  });

  it('excludes rows without real citation provenance', async () => {
    const repository: DealQueryRepository = {
      listAuthorizedDeals: async () => [opportunity],
      findAuthorizedDeal: async () => opportunity,
      findLatestRun: async () => undefined,
      listEvidence: async (_scope, category) => category === 'opportunity'
        ? [opportunityEvidence]
        : category === 'supplemental' ? [unprovenancedEvidence] : []
    };
    const workspace = await new DealsService({ repository }).getAuthorizedDealWorkspace(session, 'OPP-TEST');
    expect(workspace.evidence.map((item) => item.id)).not.toContain(unprovenancedEvidence.id);
    expect(JSON.stringify(workspace)).not.toContain('source/unavailable');
  });

  it('rejects impossible ISO dates and omits them from source mapping', async () => {
    expect(dealListItemSchema.safeParse({
      opportunityId: 'OPP-TEST', opportunityName: 'Test', accountName: 'Account', stage: 'Discovery',
      owner: null, closeDate: '2026-02-31', amount: null, currency: null, probability: null,
      riskLevel: 'unknown', restricted: false, createdAt: '2026-08-29T10:00:00.000Z', latestRun: null
    }).success).toBe(false);
    const invalidDateEvidence = {
      ...opportunityEvidence,
      content: opportunityEvidence.content
        .replace('closeDate: 2026-09-30', 'closeDate: 2026-02-31')
        .replace('2026-09-01', '2026-02-31')
    };
    const repository: DealQueryRepository = {
      listAuthorizedDeals: async () => [opportunity],
      findAuthorizedDeal: async () => opportunity,
      findLatestRun: async () => undefined,
      listEvidence: async (_scope, category) => category === 'opportunity' ? [invalidDateEvidence] : []
    };
    const workspace = await new DealsService({ repository }).getAuthorizedDealWorkspace(session, 'OPP-TEST');
    expect(workspace.deal.closeDate).toBeNull();
    expect(workspace.brief.actions[0]?.dueDate).toBeNull();
  });

  it('omits evidence with an impossible optional event date without creating citations', async () => {
    const invalidDateEvidence = {
      ...opportunityEvidence,
      eventDate: '2026-02-31'
    };
    const repository: DealQueryRepository = {
      listAuthorizedDeals: async () => [opportunity],
      findAuthorizedDeal: async () => opportunity,
      findLatestRun: async () => undefined,
      listEvidence: async (_scope, category) =>
        category === 'opportunity' ? [invalidDateEvidence] : []
    };

    const workspace = await new DealsService({ repository }).getAuthorizedDealWorkspace(
      session,
      'OPP-TEST'
    );

    expect(workspace.evidence).toEqual([]);
    expect(JSON.stringify(workspace.brief)).not.toContain(invalidDateEvidence.id);
  });

  it('fails workspace mapping for an invalid required database date', async () => {
    const invalidDateEvidence = {
      ...opportunityEvidence,
      createdAt: 'not-a-date'
    };
    const repository: DealQueryRepository = {
      listAuthorizedDeals: async () => [opportunity],
      findAuthorizedDeal: async () => opportunity,
      findLatestRun: async () => undefined,
      listEvidence: async (_scope, category) =>
        category === 'opportunity' ? [invalidDateEvidence] : []
    };

    await expect(
      new DealsService({ repository }).getAuthorizedDealWorkspace(session, 'OPP-TEST')
    ).rejects.toThrow(RangeError);
  });
});

describe('DealsService list date serialization', () => {
  it('serializes valid Date and ISO string database values', async () => {
    const repository: DealQueryRepository = {
      listAuthorizedDeals: async () => [
        {
          ...opportunity,
          latestRun: {
            status: 'completed',
            updatedAt: new Date('2026-08-30T11:00:00.000Z')
          }
        },
        {
          ...opportunity,
          opportunityId: 'OPP-STRING-DATES',
          createdAt: '2026-08-29T12:00:00.000Z',
          latestRun: {
            status: 'failed',
            updatedAt: '2026-08-30T13:00:00.000Z'
          }
        }
      ],
      findAuthorizedDeal: async () => undefined,
      findLatestRun: async () => undefined,
      listEvidence: async () => []
    };

    const deals = await new DealsService({ repository }).listAuthorizedDeals(session);

    expect(deals.map(({ createdAt, latestRun }) => ({ createdAt, latestRun }))).toEqual([
      {
        createdAt: '2026-08-29T10:00:00.000Z',
        latestRun: { status: 'completed', updatedAt: '2026-08-30T11:00:00.000Z' }
      },
      {
        createdAt: '2026-08-29T12:00:00.000Z',
        latestRun: { status: 'failed', updatedAt: '2026-08-30T13:00:00.000Z' }
      }
    ]);
  });

  it('fails list mapping for an invalid required database date', async () => {
    const repository: DealQueryRepository = {
      listAuthorizedDeals: async () => [{ ...opportunity, createdAt: 'not-a-date' }],
      findAuthorizedDeal: async () => undefined,
      findLatestRun: async () => undefined,
      listEvidence: async () => []
    };

    await expect(new DealsService({ repository }).listAuthorizedDeals(session)).rejects.toThrow(
      RangeError
    );
  });
});
