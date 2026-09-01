import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

const sections = [
  'Deal Snapshot',
  'Executive Summary',
  'Buyer Goals and Business Drivers',
  'Stakeholder Map',
  'Negotiation State',
  'Recommended Next Actions',
  'Missing Information',
  'Confidence and Review Warnings',
  'Source Evidence'
] as const;

const sourceTypeLabels = {
  gong_summary: 'Gong summary',
  gong_transcript: 'Gong transcript',
  policy: 'Policy',
  pricing: 'Pricing',
  salesforce: 'Salesforce',
  slack: 'Slack'
} as const;

async function loginAs(page: Page, name: string, returnTo = '/deals'): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole('button', { name: new RegExp(`Continue as ${name}`) }).click();
  await expect(page).toHaveURL(returnTo);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

async function openCitation(_page: Page, citation: Locator): Promise<void> {
  const element = await citation.elementHandle();
  if (element === null) throw new Error('Citation control was not rendered');
  await citation.focus();
  await citation.click();
  await expect.poll(() => element.getAttribute('aria-pressed')).toBe('true');
}

async function mockGeneratedWorkspace(page: Page, runId: string): Promise<{ preview: string }> {
  const workspace = await page.evaluate(async () => {
    const response = await fetch('/api/deals/OPP-1001', { credentials: 'same-origin' });
    return response.json() as Record<string, unknown>;
  });
  const sourceSnapshot = workspace.sourceSnapshot as {
    evidenceOverview: Record<string, unknown> & {
      sections: Record<string, Record<string, unknown>>;
    };
  };
  const preview =
    'AI-generated preview: Northstar has a supported renewal path with open execution details.';
  const generatedContent = {
    ...sourceSnapshot.evidenceOverview,
    status: 'generated',
    sections: {
      ...sourceSnapshot.evidenceOverview.sections,
      executiveSummary: {
        ...sourceSnapshot.evidenceOverview.sections.executiveSummary,
        paragraphs: [preview]
      }
    }
  };
  const generatedWorkspace = {
    ...workspace,
    generatedOutput: {
      type: 'generated_output',
      lifecycle: 'draft',
      producingRun: {
        id: runId,
        status: 'awaiting_approval',
        updatedAt: '2026-08-29T01:00:00.000Z'
      },
      approvalReview: null,
      content: generatedContent
    },
    brief: generatedContent
  };
  await page.route('**/api/deals/OPP-1001', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(generatedWorkspace)
    });
  });
  return { preview };
}

async function openSourceRecords(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Source Records' }).click();
  await expect(page.getByRole('heading', { name: 'Authorized source records' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('lists only the signed persona authorized deals and opens the pre-generation Overview and raw source records', async ({
  page
}) => {
  await loginAs(page, 'Maya Levin');

  await expect(page.getByRole('heading', { name: 'Authorized deals' })).toBeVisible();
  const deals = page.getByRole('table', { name: 'Authorized deals' });
  await expect(deals.getByText('OPP-1001', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('OPP-1002')).toHaveCount(0);
  await expect(page.getByText('OPP-1003')).toHaveCount(0);
  const desktopRow = deals.getByRole('row').filter({ hasText: 'OPP-1001' });
  await expect(desktopRow).toContainText('Probability: 78%');
  await expect(desktopRow).toContainText('Latest run: No run yet');
  await expect(desktopRow).toContainText('Access: Standard deal');

  const workspaceExpectations = await page.evaluate(async () => {
    const response = await fetch('/api/deals/OPP-1001', { credentials: 'same-origin' });
    const workspace = (await response.json()) as {
      deal: {
        opportunityId: string;
        opportunityName: string;
        accountName: string;
        stage: string;
        owner: string | null;
        closeDate: string | null;
        amount: number | null;
        probability: number | null;
        riskLevel: string;
        createdAt: string;
      };
      evidence: { sourceType: keyof typeof sourceTypeLabels }[];
    };
    const counts = new Map<keyof typeof sourceTypeLabels, number>();
    for (const record of workspace.evidence)
      counts.set(record.sourceType, (counts.get(record.sourceType) ?? 0) + 1);
    return {
      deal: workspace.deal,
      sourceAvailability: [...counts].map(([sourceType, count]) => ({ sourceType, count }))
    };
  });

  await page.getByRole('link', { name: /Open OPP-1001/ }).click();
  await expect(page).toHaveURL('/deals/OPP-1001');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Northstar Foods Cooperative - Global Access Renewal'
    })
  ).toBeVisible();
  const dealFacts = page.getByRole('region', { name: 'Deal facts' });
  const expectedDealFacts = [
    ['Opportunity ID', workspaceExpectations.deal.opportunityId],
    ['Opportunity', workspaceExpectations.deal.opportunityName],
    ['Account', workspaceExpectations.deal.accountName],
    ['Stage', workspaceExpectations.deal.stage],
    ['Owner', workspaceExpectations.deal.owner ?? 'Not recorded'],
    ['Close date', workspaceExpectations.deal.closeDate ?? 'Not recorded'],
    [
      'Amount',
      workspaceExpectations.deal.amount === null
        ? 'Not recorded'
        : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(
            workspaceExpectations.deal.amount
          )
    ],
    [
      'Probability',
      workspaceExpectations.deal.probability === null
        ? 'Not recorded'
        : `${workspaceExpectations.deal.probability}%`
    ],
    [
      'Risk',
      `${workspaceExpectations.deal.riskLevel.charAt(0).toUpperCase()}${workspaceExpectations.deal.riskLevel.slice(1)}`
    ],
    ['Access', 'Authorized'],
    ['Created', workspaceExpectations.deal.createdAt],
    ['Latest run', 'No run yet']
  ] as const;
  for (const [label, value] of expectedDealFacts) {
    await expect(dealFacts.getByText(label, { exact: true })).toBeVisible();
    await expect(dealFacts.getByText(value, { exact: true })).toBeVisible();
  }

  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('tab', { name: 'AI Brief' })).toBeDisabled();
  await expect(page.getByRole('tab', { name: 'Source Records' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No AI brief yet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Authorized inputs available' })).toBeVisible();
  const availableInputs = page.getByRole('list', { name: 'Authorized source types' });
  await expect(page.getByText(/source snapshot/iu)).toHaveCount(0);
  const renderedAvailability = (await availableInputs.getByRole('listitem').allTextContents())
    .map((item) => item.trim())
    .sort();
  const expectedAvailability = workspaceExpectations.sourceAvailability
    .map(
      ({ sourceType, count }) =>
        `${sourceTypeLabels[sourceType]} · ${count} ${count === 1 ? 'record' : 'records'}`
    )
    .sort();
  expect(renderedAvailability).toEqual(expectedAvailability);
  for (const section of sections)
    await expect(page.getByRole('heading', { name: section, exact: true })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Stakeholders' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Stakeholders' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Recommended actions' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Recommended actions' })).toHaveCount(0);
  await expect(page.getByText('Account-team update impact')).toHaveCount(0);
  const slackTourAnchors = page.locator('[data-tour="slack-evidence"]');
  await expect(slackTourAnchors).toHaveCount(1);
  await expect(slackTourAnchors).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await openSourceRecords(page);
  const slackRecord = page.getByRole('button', {
    name: 'Open source record: source=synthetic_data/slack/account_team_updates.tsv, update_id=SLK-9002'
  });
  await expect(slackRecord).toBeVisible();
  for (const { sourceType } of workspaceExpectations.sourceAvailability)
    await expect(
      page.getByRole('heading', {
        name: sourceTypeLabels[sourceType],
        exact: true
      })
    ).toBeVisible();
  await openCitation(page, slackRecord);
  await expect(page.getByText('slack:SLK-9002:0', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close evidence detail' }).click();
  await page.goBack();
  await expect(page).toHaveURL('/deals');
});

test('defaults a generated workspace to Overview, then exposes the AI Brief and raw Source Records', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, 'Maya Levin');
  const { preview } = await mockGeneratedWorkspace(page, 'run-workspace-draft');

  await page.getByRole('link', { name: /Open OPP-1001/ }).click();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('heading', { name: 'AI brief is ready' })).toBeVisible();
  const previewRegion = page.getByRole('region', { name: 'AI-generated preview' });
  await expect(previewRegion.getByText(preview, { exact: true })).toBeVisible();
  const generationDetails = page.getByRole('region', { name: 'Generation details' });
  for (const metadata of [
    'Lifecycle',
    'Draft',
    'Run ID',
    'run-workspace-draft',
    'Run status',
    'Awaiting approval',
    'Updated',
    '2026-08-29T01:00:00.000Z'
  ])
    await expect(generationDetails.getByText(metadata, { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'AI Brief' }).click();
  await expect(page.getByRole('tab', { name: 'AI Brief' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  for (const section of sections)
    await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
  const renderedSectionOrder = (await page.getByRole('heading').allTextContents()).filter(
    (heading) => sections.includes(heading as (typeof sections)[number])
  );
  expect(renderedSectionOrder).toEqual(sections);
  await expect(page.getByText(/source snapshot/iu)).toHaveCount(0);

  await expect(page.getByRole('heading', { name: 'AI provenance' })).toBeVisible();
  const provenanceRoles = page
    .getByRole('list', { name: 'AI brief provenance' })
    .getByRole('listitem');
  await expect(provenanceRoles).toHaveCount(4);
  const roleResponsibilities = [
    [
      'Conversation Intelligence',
      'Finds buyer goals, concerns, commitments, objections, and missing context in authorized conversation evidence.'
    ],
    [
      'Stakeholder Intelligence',
      'Builds the stakeholder map, influence assessment, relationship state, and coverage gaps.'
    ],
    [
      'Commercial Policy Analysis',
      'Analyzes authorized commercial terms, pricing, policy triggers, and required approvals.'
    ],
    [
      'Negotiation Strategy',
      'Synthesizes validated specialist findings into negotiation state, prioritized actions, warnings, and the final brief.'
    ]
  ] as const;
  for (const [role, responsibility] of roleResponsibilities) {
    const entry = provenanceRoles.filter({ hasText: role });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText(responsibility);
  }

  const generatedCitation = page
    .getByRole('button', {
      name: /Open evidence: source=synthetic_data\/slack\/account_team_updates\.tsv, update_id=SLK-9002/
    })
    .first();
  await openCitation(page, generatedCitation);
  await expect(page.getByRole('complementary', { name: 'Evidence detail' })).toBeVisible();
  await page.getByRole('button', { name: 'Close evidence detail' }).click();

  await openSourceRecords(page);
  for (const section of sections)
    await expect(page.getByRole('heading', { name: section, exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Open source record: source=synthetic_data/slack/account_team_updates.tsv, update_id=SLK-9002'
    })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('does not overflow the generated Overview at a narrow viewport with a long unbroken run id', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'Maya Levin');
  const longRunId = 'run_bf0be74fedb74b4ca1e29d8c6f5b3a71fe0d92c4b7a1e6f803d2c9b5a7e1f04';
  await mockGeneratedWorkspace(page, longRunId);

  await page.goto('/deals/OPP-1001');
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByText(longRunId, { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('desktop evidence uses one non-modal complementary region with replace and back history', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await loginAs(page, 'Maya Levin', '/deals/OPP-1001');
  await openSourceRecords(page);

  const first = page.getByRole('button', {
    name: 'Open source record: source=synthetic_data/slack/account_team_updates.tsv, update_id=SLK-9002'
  });
  await openCitation(page, first);

  const detail = page.getByRole('complementary', { name: 'Evidence detail' });
  await expect(detail).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(detail.getByText('slack:SLK-9002:0', { exact: true })).toBeVisible();
  await expect(
    detail.getByText('synthetic_data/slack/account_team_updates.tsv', { exact: true })
  ).toBeVisible();
  await expect(detail).toBeFocused();
  const detailBox = await detail.boundingBox();
  if (detailBox === null) throw new Error('Desktop evidence detail has no layout box');
  expect(detailBox.width).toBeGreaterThanOrEqual(360);
  expect(detailBox.width).toBeLessThanOrEqual(440);
  const mainWidth = await page
    .locator('[data-deal-main]')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(mainWidth).toBeGreaterThanOrEqual(640);

  const second = page.getByRole('button', {
    name: 'Open source record: source=synthetic_data/gong/gong_call_summaries.tsv, call_id=CALL-008'
  });
  await second.click();
  await expect(page.getByRole('complementary', { name: 'Evidence detail' })).toHaveCount(1);
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/evidence=gong_summary%3ACALL-008%3Asummary%3A0/);
  expect(await detail.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true
  );
  await detail.evaluate((element) => {
    element.scrollTop = 120;
  });
  expect(await detail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await detail.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await detail.evaluate((element) => !element.contains(document.activeElement))).toBe(true);

  await page.goBack();
  await expect(page.getByRole('complementary', { name: 'Evidence detail' })).toHaveCount(0);
  await expect(page).toHaveURL('/deals/OPP-1001');

  await openCitation(page, first);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Evidence detail' })).toHaveCount(0);
  await expect(first).toBeFocused();
});

test('mobile and constrained evidence is a full-height modal sheet with focus, inert, and scroll controls', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'Maya Levin', '/deals/OPP-1001');

  await expect(page.getByRole('table', { name: 'Stakeholders' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Stakeholders' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Recommended actions' })).toHaveCount(0);
  await openSourceRecords(page);

  const citation = page.getByRole('button', {
    name: 'Open source record: source=synthetic_data/slack/account_team_updates.tsv, update_id=SLK-9002'
  });
  await openCitation(page, citation);
  const sheet = page.getByRole('dialog', { name: 'Evidence detail' });
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByText('Authorized source record and stable citation identifiers.')
  ).toBeVisible();
  const sheetBox = await sheet.boundingBox();
  if (sheetBox === null) throw new Error('Mobile evidence sheet has no layout box');
  expect(sheetBox.height).toBeGreaterThanOrEqual(840);
  const protectedShell = page.locator('[data-protected-app-shell]');
  await expect(protectedShell).toHaveAttribute('inert', '');
  for (const selector of ['header', '#main-content', 'nav[data-layout="mobile"]']) {
    expect(
      await page
        .locator(selector)
        .first()
        .evaluate(
          (element) => (element.closest('[data-protected-app-shell]') as HTMLElement | null)?.inert
        )
    ).toBe(true);
  }

  await page.keyboard.press('Tab');
  await expect(sheet.getByRole('button', { name: 'Close evidence detail' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(sheet.getByRole('button', { name: 'Close evidence detail' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(citation).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await expect(protectedShell).not.toHaveAttribute('inert', '');
  await expectNoHorizontalOverflow(page);

  await citation.click();
  await page.getByRole('button', { name: 'Close evidence detail' }).click();
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await expect(protectedShell).not.toHaveAttribute('inert', '');

  await protectedShell.evaluate((element) => {
    (element as HTMLElement).inert = true;
  });
  await citation.evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toHaveCount(0);
  await expect(protectedShell).toHaveAttribute('inert', '');
  await protectedShell.evaluate((element) => {
    (element as HTMLElement).inert = false;
  });

  await page.goto('/deals/OPP-1001?evidence=slack%3ASLK-9002%3A0');
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await expect(protectedShell).not.toHaveAttribute('inert', '');

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test('uses a modal rather than shrinking the main column when a desktop-width viewport cannot fit both regions', async ({
  page
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await loginAs(page, 'Maya Levin', '/deals/OPP-1001');
  await openSourceRecords(page);
  const citation = page.getByRole('button', {
    name: 'Open source record: source=synthetic_data/slack/account_team_updates.tsv, update_id=SLK-9002'
  });
  await citation.click();
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Evidence detail' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('preserves complete responsive records at 320px and a short 200%-zoom equivalent', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await loginAs(page, 'Maya Levin');
  await expect(page.getByRole('table', { name: 'Authorized deals' })).toHaveCount(0);
  const dealRecord = page.getByRole('list', { name: 'Authorized deals' }).getByRole('listitem');
  for (const value of [
    'Northstar Foods Cooperative - Global Access Renewal',
    '6.0 Order Review',
    'Maya Levin',
    '2026-05-17',
    '4,217,500',
    '78%',
    'Medium risk',
    'No run yet',
    'Standard deal'
  ]) {
    await expect(dealRecord).toContainText(value);
  }
  await expectNoHorizontalOverflow(page);

  await page.getByRole('link', { name: /Open OPP-1001/ }).click();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const dealFacts = page.getByRole('region', { name: 'Deal facts' });
  await expect(dealFacts.getByText('4,217,500', { exact: true })).toBeVisible();
  await expect(dealFacts.getByText('78%', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Stakeholders' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ width: 640, height: 320 });
  await openSourceRecords(page);
  const citation = page.getByRole('button', {
    name: 'Open source record: source=synthetic_data/slack/account_team_updates.tsv, update_id=SLK-9002'
  });
  await citation.click();
  const sheet = page.getByRole('dialog', { name: 'Evidence detail' });
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  if (box === null) throw new Error('Constrained evidence sheet has no layout box');
  expect(box.height).toBeGreaterThanOrEqual(316);
  expect(await sheet.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await sheet.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('renders deterministic loading and safe error states at the production route boundary', async ({
  page
}) => {
  await loginAs(page, 'Maya Levin');
  await page.route('**/api/deals/OPP-1001', async (route) => {
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 350);
    await delay.promise;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNAVAILABLE', message: 'Unavailable' })
    });
  });
  await page.getByRole('link', { name: /Open OPP-1001/ }).click();
  await expect(page.getByRole('status', { name: 'Loading destination' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This view could not be loaded' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('renders safe empty list and workspace states with a persona recovery path', async ({
  page,
  context
}) => {
  await loginAs(page, 'Maya Levin');
  const sessionVersion = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const session = (await response.json()) as { version: string };
    return session.version;
  });
  const workspaceResponse = await page.evaluate(async () => {
    const response = await fetch('/api/deals/OPP-1001', { credentials: 'same-origin' });
    return response.json();
  });
  await page.route('**/api/deals', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/deals') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessionVersion, deals: [] })
    });
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No authorized deals' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review persona access' })).toHaveAttribute(
    'href',
    '#active-persona-control'
  );
  await expect(page.getByText(/does not reveal hidden deal names or counts/i)).toBeVisible();

  const workspacePage = await context.newPage();
  await workspacePage.route('**/api/deals/OPP-1001', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...(workspaceResponse as Record<string, unknown>),
        evidence: []
      })
    });
  });
  await workspacePage.goto('/deals/OPP-1001');
  await expect(workspacePage.getByRole('heading', { name: 'No AI brief yet' })).toBeVisible();
  await expect(
    workspacePage.getByRole('heading', {
      name: 'Authorized inputs available'
    })
  ).toBeVisible();
  await expect(workspacePage.getByText('No authorized source types are available.')).toBeVisible();
  await openSourceRecords(workspacePage);
  await expect(
    workspacePage.getByText('No authorized source records are available.')
  ).toBeVisible();
  await expect(workspacePage.getByRole('button', { name: /Open source record:/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(workspacePage);
  await workspacePage.close();
});
