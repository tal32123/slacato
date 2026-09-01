// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import type { BriefSectionView, DealWorkspaceView } from '@slacato/contracts';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
          producingRun: {
            id: 'run-1',
            status: 'completed',
            updatedAt: '2026-08-29T01:00:00.000Z'
          },
          approvalReview: null,
          content: generatedBrief
        }
      : null,
    brief: withGeneratedOutput ? generatedBrief : sourceSnapshotBrief,
    evidence: []
  };
}

function renderBrief(
  workspace: DealWorkspaceView,
  options: Readonly<{
    selectedEvidenceId?: string | null;
    onEvidence?: (evidenceId: string, trigger: HTMLButtonElement) => void;
    approvalDecision?: ReactNode;
  }> = {}
) {
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(DealBrief, {
        workspace,
        selectedEvidenceId: options.selectedEvidenceId ?? null,
        onEvidence: options.onEvidence ?? (() => undefined),
        primaryAction: null,
        approvalDecision: options.approvalDecision ?? null
      })
    )
  );
}
/** Opens the generated brief from the default deal overview. */
function openAiBrief(): void {
  fireEvent.click(screen.getByRole('tab', { name: 'AI Brief' }));
}

afterEach(() => {
  cleanup();
});

describe('DealBrief', () => {
  it('shows only deal facts and source availability before an AI brief exists', () => {
    renderBrief(buildWorkspace(false));

    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /AI Brief/ })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'No AI brief yet' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Authorized inputs available' })).toBeInTheDocument();
    expect(screen.queryByText(/source snapshot/iu)).not.toBeInTheDocument();
    for (const title of Object.values(sectionTitles))
      expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument();
  });

  it('keeps the generated brief behind an explicit AI Brief view', () => {
    renderBrief(buildWorkspace(true));

    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'AI brief is ready' })).toBeInTheDocument();
    expect(screen.getByText('Executive Summary — generated output')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Deal Snapshot' })).not.toBeInTheDocument();

    openAiBrief();

    expect(screen.getByRole('tab', { name: 'AI Brief' })).toHaveAttribute('aria-selected', 'true');
    for (const title of Object.values(sectionTitles))
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.queryByText(/source snapshot/iu)).not.toBeInTheDocument();
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

    openAiBrief();

    const notices = [...container.querySelectorAll('p')].filter((paragraph) =>
      paragraph.textContent?.startsWith('This section is empty.')
    );
    expect(notices).toHaveLength(2);
  });

  it('shows raw authorized records instead of a deterministic second brief', () => {
    renderBrief(buildWorkspace(false));

    fireEvent.click(screen.getByRole('tab', { name: 'Source Records' }));

    expect(screen.getByRole('heading', { name: 'Authorized source records' })).toBeInTheDocument();
    expect(screen.getByText('No authorized source records are available.')).toBeInTheDocument();
    for (const title of Object.values(sectionTitles))
      expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument();
  });

  it('groups raw authorized records and opens the authorized record with its trigger', () => {
    const onEvidence = vi.fn();
    renderBrief(buildCitedWorkspace(), { onEvidence });

    fireEvent.click(screen.getByRole('tab', { name: 'Source Records' }));
    const trigger = screen.getByRole('button', {
      name: `Open source record: ${slackLabel}`
    });
    expect(screen.getByRole('heading', { name: 'Slack' })).toBeInTheDocument();
    expect(screen.getByText('updateText: Executive stakeholders disagree on the lead concession.')).toBeInTheDocument();

    fireEvent.click(trigger);

    expect(onEvidence).toHaveBeenCalledWith('slack:SLK-9009:0', trigger);
  });

  it('renders the record decision immediately after the last generated section', () => {
    const approvalDecision = createElement(
      'section',
      { 'aria-label': 'Record decision' },
      createElement('button', null, 'Approve unchanged'),
      createElement('button', null, 'Edit and approve'),
      createElement('button', null, 'Reject')
    );
    const { container } = renderBrief(buildWorkspace(true), { approvalDecision });
    openAiBrief();

    const sourceEvidence = container.querySelector('[aria-labelledby=\"generated-sourceEvidence\"]');
    const decision = screen.getByRole('region', { name: 'Record decision' });
    expect(sourceEvidence).not.toBeNull();
    expect(sourceEvidence?.compareDocumentPosition(decision) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(within(decision).getByRole('button', { name: 'Approve unchanged' })).toBeInTheDocument();
    expect(within(decision).getByRole('button', { name: 'Edit and approve' })).toBeInTheDocument();
    expect(within(decision).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
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
          audience: 'internal',
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
    openAiBrief();

    // The section says which update carried the badge, and does not name the co-cited call.
    const explanation = screen.getByText(/Badged because this section cites account-team update/);
    expect(explanation).toHaveTextContent('SLK-9009');
    expect(explanation).not.toHaveTextContent('CALL-008');
    // The impacted action carries the same identification, in both the table and the mobile list.
    const actionLabels = screen.getAllByText(/Account-team update impact · SLK-9009/);
    expect(actionLabels.length).toBeGreaterThan(0);
  });

  it.each([true, false])(
    'keeps one visible Slack tour anchor on the Source Records tab when generated output is %s',
    (withGeneratedOutput) => {
      const { container } = renderBrief(buildWorkspace(withGeneratedOutput));

      const anchors = container.querySelectorAll('[data-tour="slack-evidence"]');
      expect(anchors).toHaveLength(1);
      expect(anchors[0]).toBe(screen.getByRole('tab', { name: 'Source Records' }));
      expect(anchors[0]).toBeVisible();
    }
  );
});

const gongLabel = 'source=gong/gong_call_summaries.tsv, call_id=CALL-008';
const slackLabel = 'source=slack/account_team_updates.tsv, update_id=SLK-9009';
const contactLabel = 'source=salesforce/contacts.tsv, contact_id=CON-3003';
const citedEvidence: DealWorkspaceView['evidence'] = [
  {
    id: 'gong_summary:CALL-008:0',
    sourceType: 'gong_summary',
    sourcePath: 'gong/gong_call_summaries.tsv',
    stableKey: 'call_id',
    stableId: 'CALL-008',
    citationLabel: gongLabel,
    chunkId: 'gong_summary:CALL-008:0',
    capturedAt: '2026-05-12T00:00:00.000Z',
    content: 'summary: Pricing pressure raised again.'
  },
  {
    id: 'slack:SLK-9009:0',
    sourceType: 'slack',
    sourcePath: 'slack/account_team_updates.tsv',
    stableKey: 'update_id',
    stableId: 'SLK-9009',
    citationLabel: slackLabel,
    chunkId: 'slack:SLK-9009:0',
    capturedAt: '2026-05-18T00:00:00.000Z',
    content: 'updateText: Executive stakeholders disagree on the lead concession.'
  },
  {
    id: 'salesforce:CON-3003:0',
    sourceType: 'salesforce',
    sourcePath: 'salesforce/contacts.tsv',
    stableKey: 'contact_id',
    stableId: 'CON-3003',
    citationLabel: contactLabel,
    chunkId: 'salesforce:CON-3003:0',
    capturedAt: '2026-05-02T00:00:00.000Z',
    content: 'name: Elena Voss'
  }
];

/**
 * Builds a generated workspace whose sections, stakeholder, action, and warning all cite records,
 * with the same two records cited from more than one place so numbering can be checked for reuse.
 */
function buildCitedWorkspace(): DealWorkspaceView {
  const workspace = buildWorkspace(true);
  const generated = workspace.generatedOutput;
  if (generated === null) throw new Error('Generated output fixture is required');
  const content = {
    ...generated.content,
    sections: {
      ...generated.content.sections,
      dealSnapshot: {
        ...generated.content.sections.dealSnapshot,
        citationIds: ['gong_summary:CALL-008:0']
      },
      executiveSummary: {
        ...generated.content.sections.executiveSummary,
        citationIds: ['slack:SLK-9009:0', 'gong_summary:CALL-008:0']
      },
      sourceEvidence: {
        ...generated.content.sections.sourceEvidence,
        citationIds: ['gong_summary:CALL-008:0', 'slack:SLK-9009:0', 'salesforce:CON-3003:0']
      }
    },
    stakeholders: [
      {
        name: 'Elena Voss',
        title: 'VP Operations',
        role: 'Economic buyer',
        influence: 'high',
        relationship: 'neutral',
        goals: ['Wants a clean renewal path'],
        concerns: [],
        citationIds: ['salesforce:CON-3003:0']
      }
    ],
    actions: [
      {
        action: 'Confirm the discount position with Deal Desk',
        audience: 'internal',
        owner: 'Nora Chen',
        priority: 'high',
        dueDate: null,
        rationale: 'Executive stakeholders disagree on the lead concession.',
        citationIds: ['slack:SLK-9009:0'],
        accountTeamUpdateImpact: false
      }
    ],
    warnings: [
      {
        severity: 'warning',
        message: 'Pricing was discussed on one call only.',
        citationIds: ['gong_summary:CALL-008:0'],
        accountTeamUpdateImpact: false
      }
    ]
  };
  return {
    ...workspace,
    generatedOutput: { ...generated, content },
    brief: content,
    evidence: citedEvidence
  } as DealWorkspaceView;
}

/** Reads the visible text of every marker that opens one given record. */
function markersFor(label: string): string[] {
  return screen
    .getAllByRole('button', { name: `Open evidence: ${label}` })
    .map((marker) => marker.textContent ?? '');
}

// The brief used to close every section with a wrapping row of full-width buttons, each printing
// the whole `citationLabel`. The labels now live once in Source Evidence and everything else cites
// them by a page-stable footnote number, so the prose is readable and `[3]` means one same record.
describe('DealBrief citations', () => {
  it('gives each cited record one number and reuses it everywhere that record is cited', () => {
    renderBrief(buildCitedWorkspace());
    openAiBrief();

    // First-citation order over the rendered briefs: the deal snapshot cites the call, the
    // executive summary introduces the Slack update, the stakeholder introduces the contact.
    expect(new Set(markersFor(gongLabel))).toEqual(new Set(['[1]']));
    expect(new Set(markersFor(slackLabel))).toEqual(new Set(['[2]']));
    expect(new Set(markersFor(contactLabel))).toEqual(new Set(['[3]']));
    // Each record is cited from several places, so reuse is what is actually being checked.
    expect(markersFor(gongLabel).length).toBeGreaterThan(1);
    expect(markersFor(slackLabel).length).toBeGreaterThan(1);
  });

  it('keeps the numbering stable while switching between deal views', () => {
    renderBrief(buildCitedWorkspace());
    openAiBrief();
    const rendered = markersFor(slackLabel);

    fireEvent.click(screen.getByRole('tab', { name: 'Source Records' }));
    fireEvent.click(screen.getByRole('tab', { name: 'AI Brief' }));

    expect(markersFor(slackLabel)).toEqual(rendered);
    expect(new Set(markersFor(gongLabel))).toEqual(new Set(['[1]']));
  });

  it('marks each stakeholder, action, and warning with the records behind it', () => {
    renderBrief(buildCitedWorkspace());
    openAiBrief();

    // Desktop table and mobile card both carry the stakeholder's own citation.
    const stakeholderMarkers = screen.getAllByRole('list', { name: 'Citations for Elena Voss' });
    expect(stakeholderMarkers).toHaveLength(2);
    for (const list of stakeholderMarkers)
      expect(within(list).getByRole('button', { name: `Open evidence: ${contactLabel}` })).toHaveTextContent('[3]');

    const actionMarkers = screen.getAllByRole('list', { name: 'Action citations' });
    expect(actionMarkers).toHaveLength(2);
    for (const list of actionMarkers)
      expect(within(list).getByRole('button', { name: `Open evidence: ${slackLabel}` })).toHaveTextContent('[2]');

    const warningMarkers = screen.getAllByRole('list', { name: 'Warning citations' });
    expect(warningMarkers).toHaveLength(1);
    expect(
      within(warningMarkers[0]).getByRole('button', { name: `Open evidence: ${gongLabel}` })
    ).toHaveTextContent('[1]');
  });

  it('spells the full citation labels out once, as the numbered Source Evidence list', () => {
    const { container } = renderBrief(buildCitedWorkspace());
    openAiBrief();

    const references = screen.getAllByRole('list', { name: 'Numbered source evidence' })[0];
    const entries = within(references).getAllByRole('listitem');
    expect(entries.map((entry) => entry.textContent)).toEqual([
      `[1]${gongLabel}`,
      `[2]${slackLabel}`,
      `[3]${contactLabel}`
    ]);
    // The verbatim label is the only citation format shown; nothing invents a second one.
    const sourceEvidence = container.querySelector('[aria-labelledby="generated-sourceEvidence"]');
    expect(within(sourceEvidence as HTMLElement).getAllByText(gongLabel)).toHaveLength(1);
    // And no marker prints a label any more -- that pile of long chips is what got replaced.
    for (const button of container.querySelectorAll('button'))
      expect(button.textContent).not.toContain('source=');
  });

  it('keeps the guided tour anchor on a labeled row of section sources', () => {
    const { container } = renderBrief(buildCitedWorkspace());
    openAiBrief();

    const anchors = [...container.querySelectorAll('[data-tour="citations"]')];
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor.textContent).toContain('Sources');
      expect(anchor.querySelectorAll('button').length).toBeGreaterThan(0);
    }
  });

  it('opens the record a marker cites and shows which one is selected', () => {
    const onEvidence = vi.fn();
    const { unmount } = renderBrief(buildCitedWorkspace(), { onEvidence });
    openAiBrief();

    fireEvent.click(screen.getAllByRole('button', { name: `Open evidence: ${slackLabel}` })[0]);

    expect(onEvidence).toHaveBeenCalledTimes(1);
    expect(onEvidence.mock.calls[0][0]).toBe('slack:SLK-9009:0');
    expect(onEvidence.mock.calls[0][1]).toBeInstanceOf(HTMLButtonElement);
    unmount();

    renderBrief(buildCitedWorkspace(), { selectedEvidenceId: 'slack:SLK-9009:0' });
    openAiBrief();
    for (const marker of screen.getAllByRole('button', { name: `Open evidence: ${slackLabel}` }))
      expect(marker).toHaveAttribute('aria-pressed', 'true');
    for (const marker of screen.getAllByRole('button', { name: `Open evidence: ${gongLabel}` }))
      expect(marker).toHaveAttribute('aria-pressed', 'false');
  });
});
