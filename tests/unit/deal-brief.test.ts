// @vitest-environment jsdom

import { createElement } from 'react';
import type { BriefSectionView, DealWorkspaceView } from '@slacato/contracts';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { DealBrief } from '../../apps/web/src/features/briefs/deal-brief';

const sectionTitles = {
  dealSnapshot: 'Deal Snapshot',
  executiveSummary: 'Executive Summary',
  buyerGoalsAndBusinessDrivers: 'Buyer Goals and Business Drivers',
  stakeholderMap: 'Stakeholder Map',
  negotiationState: 'Negotiation State',
  recommendedNextActions: 'Recommended Next Actions',
  missingInformation: 'Missing Information',
  sourceEvidence: 'Source Evidence',
  confidenceAndReviewWarnings: 'Confidence and Review Warnings'
} as const;

/** Builds one deterministic brief section with a paragraph identifying which brief produced it. */
function buildSection(title: string, paragraph: string): BriefSectionView {
  return {
    title,
    paragraphs: [paragraph],
    items: [],
    citationIds: [],
    accountTeamUpdateImpact: false
  };
}

/** Builds a full nine-section brief whose paragraphs are tagged with the given source label. */
function buildSections(status: 'source_backed' | 'generated', tag: string) {
  const sections = Object.fromEntries(
    Object.entries(sectionTitles).map(([id, title]) => [id, buildSection(title, `${title} — ${tag}`)])
  ) as Record<keyof typeof sectionTitles, BriefSectionView>;
  return { status, overallConfidence: 0.7, sections, stakeholders: [], actions: [], warnings: [] };
}

const deal: DealWorkspaceView['deal'] = {
  opportunityId: 'OPP-1',
  opportunityName: 'Renewal',
  accountName: 'Northstar',
  stage: 'Negotiation',
  owner: 'Test Owner',
  closeDate: null,
  amount: null,
  currency: null,
  probability: null,
  riskLevel: 'medium',
  restricted: false,
  createdAt: '2026-08-29T00:00:00.000Z',
  latestRun: null
};

function buildWorkspace(withGeneratedOutput: boolean): DealWorkspaceView {
  const sourceSnapshotBrief = buildSections('source_backed', 'source snapshot') as DealWorkspaceView['sourceSnapshot']['evidenceOverview'];
  const generatedBrief = buildSections('generated', 'generated output') as NonNullable<
    DealWorkspaceView['generatedOutput']
  >['content'];
  return {
    sessionVersion: 'session-v1',
    deal,
    sourceSnapshot: { type: 'source_snapshot', label: 'Source snapshot', evidenceOverview: sourceSnapshotBrief },
    generatedOutput: withGeneratedOutput
      ? {
          type: 'generated_output',
          lifecycle: 'finalized',
          producingRun: { id: 'run-1', status: 'completed', updatedAt: '2026-08-29T01:00:00.000Z' },
          content: generatedBrief
        }
      : null,
    brief: withGeneratedOutput ? generatedBrief : sourceSnapshotBrief,
    evidence: []
  };
}

function renderBrief(workspace: DealWorkspaceView) {
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(DealBrief, {
        workspace,
        selectedEvidenceId: null,
        onEvidence: () => undefined,
        primaryAction: null
      })
    )
  );
}

afterEach(() => {
  cleanup();
});

describe('DealBrief', () => {
  it('renders the deterministic snapshot in full, with no disclosure, when there is no generated output', () => {
    const { container } = renderBrief(buildWorkspace(false));

    expect(container.querySelector('details')).toBeNull();

    for (const title of Object.values(sectionTitles)) {
      const headings = screen.getAllByRole('heading', { level: 3, name: new RegExp(`^${title}`) });
      expect(headings).toHaveLength(1);
    }
    expect(screen.getByText(/Deal Snapshot — source snapshot/)).toBeInTheDocument();
  });

  it('renders each section heading once at top level and collapses the snapshot into a labeled, closed disclosure when a brief is generated', () => {
    const { container } = renderBrief(buildWorkspace(true));

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);

    // Every canonical section heading appears exactly once outside the collapsed disclosure.
    const topLevelHeadings = [...container.querySelectorAll('h3')].filter(
      (heading) => details === null || !details.contains(heading)
    );
    expect(topLevelHeadings).toHaveLength(Object.keys(sectionTitles).length);
    for (const title of Object.values(sectionTitles)) {
      const matches = topLevelHeadings.filter((heading) => heading.textContent?.startsWith(title));
      expect(matches).toHaveLength(1);
    }
    // The primary generated content, not the deterministic snapshot, is what's visible at top level.
    expect(within(container).getByText(/Deal Snapshot — generated output/)).toBeInTheDocument();

    // The deterministic snapshot remains reachable inside the disclosure, unambiguously labeled.
    expect(details).not.toBeNull();
    const summary = details?.querySelector('summary');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toMatch(/Source snapshot/);
    expect(summary?.textContent).toMatch(/not AI-generated/);
    const snapshotHeadings = [...(details?.querySelectorAll('h3') ?? [])];
    expect(snapshotHeadings).toHaveLength(Object.keys(sectionTitles).length);
    expect(details?.textContent).toMatch(/Deal Snapshot — source snapshot/);

    // Keyboard operability: the disclosure is a native, focusable summary element (not a div/span).
    expect(summary?.tagName).toBe('SUMMARY');
  });

  it('names an empty generated section instead of leaving a bare heading over blank space', () => {
    const workspace = buildWorkspace(true);
    const generated = workspace.generatedOutput;
    if (generated === null) throw new Error('Generated output fixture is required');
    const emptied = {
      ...generated.content,
      sections: {
        ...generated.content.sections,
        missingInformation: { ...generated.content.sections.missingInformation, paragraphs: [], items: [] },
        buyerGoalsAndBusinessDrivers: {
          ...generated.content.sections.buyerGoalsAndBusinessDrivers,
          paragraphs: [],
          items: []
        }
      }
    };
    const { container } = renderBrief({
      ...workspace,
      generatedOutput: { ...generated, content: emptied },
      brief: emptied
    } as DealWorkspaceView);

    const notices = [...container.querySelectorAll('p')].filter((paragraph) =>
      paragraph.textContent?.startsWith('This section is empty.')
    );
    expect(notices).toHaveLength(2);
  });

  it('names an empty deterministic section in the language of authorized records', () => {
    const workspace = buildWorkspace(false);
    const emptied = {
      ...workspace.sourceSnapshot.evidenceOverview,
      sections: {
        ...workspace.sourceSnapshot.evidenceOverview.sections,
        missingInformation: {
          ...workspace.sourceSnapshot.evidenceOverview.sections.missingInformation,
          paragraphs: [],
          items: []
        }
      }
    };
    renderBrief({
      ...workspace,
      sourceSnapshot: { ...workspace.sourceSnapshot, evidenceOverview: emptied },
      brief: emptied
    } as DealWorkspaceView);

    expect(screen.getByText('No authorized records populate this section.')).toBeInTheDocument();
  });

  // The "Account-team update impact" badge told a reviewer that generated Slack-style chatter moved
  // a section, but not which update did it, which is the only part they can check. The badge now
  // names the cited update ids, in the section body and on impacted actions and warnings alike.
  it('names the cited account-team update behind an impact badge', () => {
    const workspace = buildWorkspace(true);
    const generated = workspace.generatedOutput;
    if (generated === null) throw new Error('Generated output fixture is required');
    const impacted = {
      ...generated.content,
      sections: {
        ...generated.content.sections,
        executiveSummary: {
          ...generated.content.sections.executiveSummary,
          citationIds: ['slack:SLK-9009:0', 'gong_summary:CALL-008:0'],
          accountTeamUpdateImpact: true
        }
      },
      actions: [
        {
          action: 'Confirm the discount position with Deal Desk',
          owner: 'Nora Chen',
          priority: 'high',
          dueDate: null,
          rationale: 'Executive stakeholders disagree on the lead concession.',
          citationIds: ['slack:SLK-9009:0'],
          accountTeamUpdateImpact: true
        }
      ]
    };
    renderBrief({
      ...workspace,
      generatedOutput: { ...generated, content: impacted },
      brief: impacted,
      evidence: [
        {
          id: 'slack:SLK-9009:0',
          sourceType: 'slack',
          sourcePath: 'slack/account_team_updates.tsv',
          stableKey: 'update_id',
          stableId: 'SLK-9009',
          citationLabel: 'source=slack/account_team_updates.tsv, update_id=SLK-9009',
          chunkId: 'slack:SLK-9009:0',
          capturedAt: '2026-05-18T00:00:00.000Z',
          content: 'updateText: Executive stakeholders disagree on the lead concession.'
        },
        {
          id: 'gong_summary:CALL-008:0',
          sourceType: 'gong_summary',
          sourcePath: 'gong/gong_call_summaries.tsv',
          stableKey: 'call_id',
          stableId: 'CALL-008',
          citationLabel: 'source=gong/gong_call_summaries.tsv, call_id=CALL-008',
          chunkId: 'gong_summary:CALL-008:0',
          capturedAt: '2026-05-12T00:00:00.000Z',
          content: 'summary: Pricing pressure raised again.'
        }
      ]
    } as DealWorkspaceView);

    // The section says which update carried the badge, and does not name the co-cited call.
    const explanation = screen.getByText(/Badged because this section cites account-team update/);
    expect(explanation).toHaveTextContent('SLK-9009');
    expect(explanation).not.toHaveTextContent('CALL-008');
    // The impacted action carries the same identification, in both the table and the mobile list.
    const actionLabels = screen.getAllByText(/Account-team update impact · SLK-9009/);
    expect(actionLabels.length).toBeGreaterThan(0);
  });

  // Regression: both views render a section called Source Evidence, and both carried the same
  // `data-tour="slack-evidence"` anchor. The guided tour resolves an anchor by DOM order, so its
  // Slack step always framed the generated brief's copy while its wording described the source
  // snapshot's -- thousands of pixels below, inside a closed disclosure, and never spotlit.
  it('anchors the Slack tour step to the generated brief when there is one', () => {
    const { container } = renderBrief(buildWorkspace(true));

    const anchors = container.querySelectorAll('[data-tour="slack-evidence"]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute('aria-labelledby')).toBe('generated-sourceEvidence');
    // The snapshot's own copy is still addressable, under a name no step confuses with the other.
    expect(
      container.querySelector('[data-tour="snapshot-source-evidence"]')?.getAttribute('aria-labelledby')
    ).toBe('source_backed-sourceEvidence');
  });

  // Cancelling or resetting a run leaves the deal with no generated output, and the tour can also
  // reach this step after "Continue without generating". Anchoring only the generated brief would
  // leave the step with nothing to frame in exactly the state a pre-demo reset produces.
  it('anchors the Slack tour step to the snapshot when that is the only brief on the page', () => {
    const { container } = renderBrief(buildWorkspace(false));

    const anchors = container.querySelectorAll('[data-tour="slack-evidence"]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute('aria-labelledby')).toBe('source_backed-sourceEvidence');
    expect(container.querySelector('[data-tour="snapshot-source-evidence"]')).toBeNull();
    // And it is genuinely on screen: rendered directly, not inside the collapsed disclosure the
    // snapshot lives in whenever a generated brief is also present.
    expect(anchors[0]?.closest('details')).toBeNull();
  });
});
