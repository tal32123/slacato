// @vitest-environment jsdom

import {
  type ApprovalBriefPayload,
  type ApprovalClaim,
  type ApprovalDetailResponse,
  approvalBriefPayloadSchema,
  type DemoSession
} from '@slacato/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, Fragment, useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { DealApprovalDecision } from '../../apps/web/src/features/approvals/deal-approval-decision';
import { approvalDetailQueryOptions } from '../../apps/web/src/features/approvals/queries';
import { ApprovalSubjectDetail } from '../../apps/web/src/features/approvals/subject-section';

const readableEvidenceId = 'salesforce:OPP-1001:0';
const unreadableEvidenceId = 'slack:SLK-9002:0';

/** Builds one claim citing a single evidence version, mirroring the shape the workflow emits. */
function buildClaim(id: string, statement: string, evidenceId: string): ApprovalClaim {
  return {
    id,
    statement,
    confidence: 0.8,
    citations: [{ id: `citation_${id}`, evidenceId, locator: `locator/${evidenceId}` }]
  };
}

/**
 * Builds a payload whose first evidence entry is authorized and whose second is not.
 *
 * The two entries are what the numbered citation markers point into, so ordering them this way
 * makes `[1]` the authorized marker and `[2]` the one that must stay inert.
 */
function buildPayload(): ApprovalBriefPayload {
  return {
    dealSnapshot: {
      accountName: 'Northstar Foods Cooperative',
      opportunityName: 'Global Access Renewal',
      stage: '6.0 Order Review',
      claims: [buildClaim('claim_ds_1', 'Close date is committed for April.', readableEvidenceId)]
    },
    executiveSummary: {
      narrative: 'Renewal terms remain open.',
      claims: [
        buildClaim('claim_exec_1', 'Legal review is the last open item.', unreadableEvidenceId)
      ]
    },
    buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
    stakeholderMap: {
      stakeholders: [
        {
          name: 'Elena Voss',
          role: 'economic_buyer',
          influence: 'high',
          relationship: 'positive',
          goals: [],
          concerns: [],
          claims: [buildClaim('claim_stk_1', 'Elena Voss signs the renewal.', readableEvidenceId)]
        }
      ]
    },
    negotiationState: {
      currentState: 'Pricing is agreed; payment schedule is not.',
      risks: [],
      claims: [buildClaim('claim_neg_2', 'Payment schedule is unconfirmed.', readableEvidenceId)]
    },
    recommendedNextActions: {
      actions: [
        {
          action: 'Send the revised order form.',
          audience: 'customer',
          priority: 'high',
          rationale: 'The buyer is waiting on it.',
          claims: [
            buildClaim('claim_act_1', 'The revised order form is outstanding.', readableEvidenceId)
          ]
        }
      ]
    },
    missingInformation: { items: [] },
    sourceEvidence: {
      evidence: [
        {
          evidenceId: readableEvidenceId,
          sourceType: 'crm',
          summary: 'Opportunity record for the Global Access renewal.',
          claims: []
        },
        {
          evidenceId: unreadableEvidenceId,
          sourceType: 'slack',
          summary: 'Account-team update on the legal review.',
          claims: []
        }
      ]
    },
    confidenceAndReviewWarnings: {
      overallConfidence: 0.95,
      warnings: [
        {
          code: 'MISSING_PAYMENT_SCHEDULE_APPROVAL',
          severity: 'warning',
          message: 'Payment schedule approval must be confirmed.',
          claimIds: ['claim_neg_2']
        },
        {
          code: 'INSUFFICIENT_CLAIM_SUPPORT',
          severity: 'warning',
          message: 'One cited record does not state: acv, renewal',
          claimIds: []
        }
      ]
    }
  };
}

/** Exercises the subject's evidence-selection interface with observable parent-owned state. */
function SubjectHarness(): React.JSX.Element {
  const [selectedEvidenceId, setSelectedEvidenceId] = useState('none');
  return createElement(
    Fragment,
    null,
    createElement(ApprovalSubjectDetail, {
      payload: buildPayload(),
      evidenceIds: new Set([readableEvidenceId]),
      onEvidence: (evidenceId: string) => setSelectedEvidenceId(evidenceId)
    }),
    createElement('output', { 'aria-label': 'Selected evidence' }, selectedEvidenceId)
  );
}

/** Renders the approval subject with only the first evidence version authorized. */
function renderSubject() {
  return render(createElement(MemoryRouter, null, createElement(SubjectHarness)));
}

/** Finds the section element whose heading carries the given title. */
function section(container: HTMLElement, title: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name: title });
  const found = heading.closest('section');
  if (found === null) throw new Error(`No section wraps the "${title}" heading.`);
  expect(container.contains(found)).toBe(true);
  return found;
}

afterEach(() => {
  cleanup();
});

describe('ApprovalSubjectDetail evidence attribution', () => {
  it('exercises a payload the approval contract accepts', () => {
    expect(approvalBriefPayloadSchema.safeParse(buildPayload()).success).toBe(true);
  });

  it('renders each claim beside the section it supports, with a citation marker into the evidence roll-up', () => {
    const { container } = renderSubject();

    const snapshot = section(container, 'Deal snapshot');
    expect(within(snapshot).getByText('Close date is committed for April.')).toBeInTheDocument();
    expect(within(snapshot).getByText('80% confidence')).toBeInTheDocument();
    const marker = within(snapshot).getByRole('link', { name: 'Evidence 1' });
    expect(marker).toHaveAttribute('href', '#approval-evidence-1');
    expect(marker).toHaveTextContent('[1]');
    expect(within(snapshot).getByLabelText('Claim citations')).toContainElement(marker);
  });

  it('attaches claims and citations to each stakeholder and each recommended action', () => {
    const { container } = renderSubject();

    const stakeholders = section(container, 'Stakeholder map');
    expect(within(stakeholders).getByText('Elena Voss signs the renewal.')).toBeInTheDocument();
    expect(
      within(stakeholders).getAllByRole('link', { name: 'Evidence 1' }).length
    ).toBeGreaterThan(0);

    const actions = section(container, 'Recommended next actions');
    expect(within(actions).getByText('The revised order form is outstanding.')).toBeInTheDocument();
    expect(within(actions).getAllByRole('link', { name: 'Evidence 1' }).length).toBeGreaterThan(0);
  });

  it('renders a citation to unauthorized evidence as plain text rather than a link', () => {
    const { container } = renderSubject();

    const summary = section(container, 'Executive summary');
    expect(within(summary).getByText('Legal review is the last open item.')).toBeInTheDocument();
    expect(within(summary).queryByRole('link')).toBeNull();
    expect(within(summary).getByText('[2]')).toBeInTheDocument();
    expect(within(summary).getByText('[2]').tagName).toBe('SPAN');
  });

  it('opens authorized evidence in place instead of linking to the deal workspace', () => {
    const { container } = renderSubject();

    const evidence = section(container, 'Authorized evidence summaries');
    expect(evidence.querySelector('#approval-evidence-1')).not.toBeNull();
    expect(evidence.querySelector('#approval-evidence-2')).not.toBeNull();
    const button = within(evidence).getByRole('button', { name: 'Open authorized evidence' });
    fireEvent.click(button);

    expect(screen.getByRole('status', { name: 'Selected evidence' })).toHaveTextContent(
      readableEvidenceId
    );
    expect(within(evidence).queryByRole('link', { name: 'Open authorized evidence' })).toBeNull();
  });

  it('names the claim a review warning was raised against and stays silent when it references none', () => {
    const { container } = renderSubject();

    const warnings = section(container, 'Confidence and review warnings');
    expect(
      within(warnings).getByText('Raised against: Payment schedule is unconfirmed.')
    ).toBeInTheDocument();
    expect(within(warnings).getAllByText(/^Raised against:/)).toHaveLength(1);
  });

  it('cites a bullet in place instead of repeating it as a claim underneath', () => {
    // Roughly half of a real section's claims restate one of its bullets word for word, so the
    // page must attribute the bullet rather than print the same sentence twice.
    const shared = 'Operations wants fewer regional exceptions.';
    const payload: ApprovalBriefPayload = {
      ...buildPayload(),
      buyerGoalsAndBusinessDrivers: {
        goals: [shared],
        businessDrivers: [],
        claims: [buildClaim('claim_goal_1', shared, readableEvidenceId)]
      }
    };
    const { container } = render(
      createElement(
        MemoryRouter,
        null,
        createElement(ApprovalSubjectDetail, {
          payload,
          evidenceIds: new Set([readableEvidenceId]),
          onEvidence: () => undefined
        })
      )
    );
    const goals = section(container, 'Buyer goals and business drivers');
    expect(within(goals).getAllByText(shared)).toHaveLength(1);
    const bullet = within(goals).getByText(shared).closest('li');
    if (bullet === null) throw new Error('The goal did not render as a list item.');
    expect(within(bullet).getByRole('link', { name: 'Evidence 1' })).toBeInTheDocument();
    // Every claim was cited on a bullet, so the section is fully attributed and needs no list.
    expect(within(goals).queryByText('Supporting claims')).not.toBeInTheDocument();
  });

  it('says so honestly when a section carries no supported claims', () => {
    const { container } = renderSubject();

    const goals = section(container, 'Buyer goals and business drivers');
    expect(
      within(goals).getByText('No buyer goal claims were supported by the validated evidence.')
    ).toBeInTheDocument();
  });
});

const approvalSession: DemoSession = {
  authenticated: true,
  persona: { userId: 'USR-5001', displayName: 'Rina Patel', role: 'Deal Desk' },
  version: '00000000-0000-4000-8000-000000000001'
};

/** Builds the server detail used by the embedded deal-workspace approval review. */
function buildApprovalDetail(entries: ApprovalDetailResponse['entries']): ApprovalDetailResponse {
  return {
    sessionVersion: approvalSession.version,
    approvalSubjectId: 'approval-subject-1',
    runId: 'run-1',
    runVersion: 3,
    subjectHash: 'a'.repeat(64),
    opportunityId: 'OPP-1001',
    opportunityName: 'Global Access Renewal',
    accountName: 'Northstar Foods Cooperative',
    status: 'awaiting_approval',
    payload: buildPayload(),
    evidence: [],
    entries,
    decisions: [],
    quorum: {
      completed: entries.filter(({ decided }) => decided).length,
      required: entries.length
    },
    capabilities: { canReadDeal: true, canEditPayload: true },
    createdAt: '2026-08-29T00:00:00.000Z',
    supersededBySubjectId: null
  };
}

/** Renders the public embedded decision component with its detail already loaded in query state. */
function renderDealApproval(detail: ApprovalDetailResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  const options = approvalDetailQueryOptions(approvalSession.version, detail.approvalSubjectId);
  client.setQueryData(options.queryKey, detail);
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(DealApprovalDecision, {
          approvalReview: { approvalSubjectId: detail.approvalSubjectId },
          session: approvalSession
        })
      )
    )
  );
}

describe('DealApprovalDecision requirement context', () => {
  it('shows the policy reason, category, current authority, and dependency before acting', () => {
    renderDealApproval(
      buildApprovalDetail([
        {
          entryId: 'legal-review',
          category: 'legal_terms',
          policyTriggers: [],
          requiredAuthorities: ['legal_reviewer'],
          availableAuthority: null,
          dependsOn: [],
          decided: true
        },
        {
          entryId: 'communication-review',
          category: 'customer_communication',
          policyTriggers: ['external_customer_communication'],
          requiredAuthorities: ['account_owner'],
          availableAuthority: 'account_owner',
          dependsOn: ['legal-review'],
          decided: false
        }
      ])
    );

    expect(screen.getByRole('heading', { name: 'Approval requirements' })).toBeInTheDocument();
    expect(screen.getByText('Customer Communication')).toBeInTheDocument();
    expect(screen.getByText('Reasons: External Customer Communication')).toBeInTheDocument();
    expect(screen.getByText('Your authority: Account Owner')).toBeInTheDocument();
    expect(screen.getByText('Depends on legal-review')).toBeInTheDocument();
    const requirements = screen
      .getByRole('heading', { name: 'Approval requirements' })
      .closest('section');
    const decision = screen.getByRole('region', { name: 'Record decision' });
    expect(requirements).not.toBeNull();
    expect(requirements?.compareDocumentPosition(decision) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it.each([
    {
      state: 'blocked',
      entry: {
        entryId: 'communication-review',
        category: 'customer_communication',
        policyTriggers: ['external_customer_communication'],
        requiredAuthorities: ['account_owner'],
        availableAuthority: 'account_owner',
        dependsOn: ['legal-review'],
        decided: false
      } satisfies ApprovalDetailResponse['entries'][number],
      status: 'Your authority: Account Owner'
    },
    {
      state: 'already decided',
      entry: {
        entryId: 'communication-review',
        category: 'customer_communication',
        policyTriggers: ['external_customer_communication'],
        requiredAuthorities: ['account_owner'],
        availableAuthority: null,
        dependsOn: [],
        decided: true
      } satisfies ApprovalDetailResponse['entries'][number],
      status: 'Decided'
    }
  ])('keeps the requirement visible when it is $state and has no controls', ({ entry, status }) => {
    renderDealApproval(buildApprovalDetail([entry]));

    expect(screen.getByText('Reasons: External Customer Communication')).toBeInTheDocument();
    expect(screen.getByText(status)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Record decision' })).not.toBeInTheDocument();
  });
});
