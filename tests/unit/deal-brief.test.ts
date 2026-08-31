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
});
