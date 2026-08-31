import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

const sections = [
  'Deal Snapshot',
  'Executive Summary',
  'Buyer Goals and Business Drivers',
  'Stakeholder Map',
  'Negotiation State',
  'Recommended Next Actions',
  'Missing Information',
  'Source Evidence',
  'Confidence and Review Warnings'
] as const;

async function loginAs(page: Page, name: string, returnTo = '/deals'): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole('button', { name: new RegExp(`Continue as ${name}`) }).click();
  await expect(page).toHaveURL(returnTo);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function openCitation(_page: Page, citation: Locator): Promise<void> {
  const element = await citation.elementHandle();
  if (element === null) throw new Error('Citation control was not rendered');
  await citation.focus();
  await citation.click();
  await expect.poll(() => element.getAttribute('aria-pressed')).toBe('true');
}

test.describe.configure({ mode: 'serial' });

test('lists only the signed persona authorized deals and opens the source-snapshot workspace', async ({ page }) => {
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

  await page.getByRole('link', { name: /Open OPP-1001/ }).click();
  await expect(page).toHaveURL('/deals/OPP-1001');
  await expect(page.getByRole('heading', { level: 1, name: /Northstar Foods Cooperative/ })).toBeVisible();
  await expect(page.getByText('OPP-1001', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Order Review/).first()).toBeVisible();
  await expect(page.getByText(/medium risk/i).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Source snapshot', exact: true })).toBeVisible();
  await expect(page.getByText('Evidence overview assembled deterministically from currently authorized, ingested records. It is not AI-generated and is not produced by a run.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Generated draft', exact: true })).toHaveCount(0);

  for (const section of sections) {
    await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('table', { name: 'Stakeholders' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Goals' })).toBeVisible();
  const elena = page.getByRole('table', { name: 'Stakeholders' }).getByRole('row').filter({ hasText: 'Elena Voss' });
  await expect(elena).toContainText('None recorded');
  await expect(elena).toContainText('Wants a clean renewal path');
  await expect(page.getByRole('table', { name: 'Recommended actions' })).toBeVisible();
  await expect(page.getByText('Account-team update impact').first()).toBeVisible();
  await expect(page.getByRole('button', {
    name: /source=slack\/account_team_updates\.tsv, update_id=SLK-9002/
  }).first()).toBeVisible();
  const sourceEvidence = page.getByRole('heading', { name: 'Source Evidence', exact: true }).locator('..').locator('..');
  await expect(sourceEvidence.getByText('source=slack/account_team_updates.tsv, update_id=SLK-9002', { exact: true })).toHaveCount(1);
  await expectNoHorizontalOverflow(page);

  const historyCitation = page.getByRole('button', {
    name: /source=slack\/account_team_updates\.tsv, update_id=SLK-9002/
  }).first();
  await openCitation(page, historyCitation);
  await page.getByRole('button', { name: 'Close evidence detail' }).click();
  await page.goBack();
  await expect(page).toHaveURL('/deals');
});

test('shows a generated draft separately from the source snapshot and names its producing run', async ({ page }) => {
  await loginAs(page, 'Maya Levin');
  const workspace = await page.evaluate(async () => {
    const response = await fetch('/api/deals/OPP-1001', { credentials: 'same-origin' });
    return response.json() as Record<string, unknown>;
  });
  const sourceSnapshot = workspace.sourceSnapshot as { evidenceOverview: Record<string, unknown> };
  const generatedContent = { ...sourceSnapshot.evidenceOverview, status: 'generated' };
  const generatedWorkspace = {
    ...workspace,
    generatedOutput: {
      type: 'generated_output', lifecycle: 'draft',
      producingRun: { id: 'run-workspace-draft', status: 'awaiting_approval', updatedAt: '2026-08-29T01:00:00.000Z' },
      content: generatedContent
    },
    brief: generatedContent
  };
  await page.route('**/api/deals/OPP-1001', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(generatedWorkspace) });
  });

  await page.getByRole('link', { name: /Open OPP-1001/ }).click();
  await expect(page.getByRole('heading', { name: 'Source snapshot', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Generated draft', exact: true })).toBeVisible();
  await expect(page.getByText('Produced by run run-workspace-draft · awaiting approval')).toBeVisible();
});

test('desktop evidence uses one non-modal complementary region with replace and back history', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await loginAs(page, 'Maya Levin', '/deals/OPP-1001');

  const first = page.getByRole('button', {
    name: /source=slack\/account_team_updates\.tsv, update_id=SLK-9002/
  }).first();
  await openCitation(page, first);

  const detail = page.getByRole('complementary', { name: 'Evidence detail' });
  await expect(detail).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(detail.getByText('slack:SLK-9002:0', { exact: true })).toBeVisible();
  await expect(detail.getByText('slack/account_team_updates.tsv', { exact: true })).toBeVisible();
  await expect(detail).toBeFocused();
  const detailBox = await detail.boundingBox();
  expect(detailBox!.width).toBeGreaterThanOrEqual(360);
  expect(detailBox!.width).toBeLessThanOrEqual(440);
  const mainWidth = await page.locator('[data-deal-main]').evaluate((element) => element.getBoundingClientRect().width);
  expect(mainWidth).toBeGreaterThanOrEqual(640);

  const second = page.getByRole('button', {
    name: /source=gong\/gong_call_summaries\.tsv, call_id=CALL-008/
  }).first();
  await second.click();
  await expect(page.getByRole('complementary', { name: 'Evidence detail' })).toHaveCount(1);
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/evidence=gong_summary%3ACALL-008%3Asummary%3A0/);
  expect(await detail.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await detail.evaluate((element) => { element.scrollTop = 120; });
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

test('mobile and constrained evidence is a full-height modal sheet with focus, inert, and scroll controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'Maya Levin', '/deals/OPP-1001');

  await expect(page.getByRole('table', { name: 'Stakeholders' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Stakeholders' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recommended actions' })).toBeVisible();

  const citation = page.getByRole('button', {
    name: /source=slack\/account_team_updates\.tsv, update_id=SLK-9002/
  }).first();
  await openCitation(page, citation);
  const sheet = page.getByRole('dialog', { name: 'Evidence detail' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Authorized source record and stable citation identifiers.')).toBeVisible();
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox!.height).toBeGreaterThanOrEqual(840);
  const protectedShell = page.locator('[data-protected-app-shell]');
  await expect(protectedShell).toHaveAttribute('inert', '');
  for (const selector of ['header', '#main-content', 'nav[data-layout="mobile"]']) {
    expect(await page.locator(selector).first().evaluate((element) => (element.closest('[data-protected-app-shell]') as HTMLElement | null)?.inert)).toBe(true);
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

  await protectedShell.evaluate((element) => { (element as HTMLElement).inert = true; });
  await citation.evaluate((element) => { (element as HTMLButtonElement).click(); });
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toHaveCount(0);
  await expect(protectedShell).toHaveAttribute('inert', '');
  await protectedShell.evaluate((element) => { (element as HTMLElement).inert = false; });

  await page.goto('/deals/OPP-1001?evidence=slack%3ASLK-9002%3A0');
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await expect(protectedShell).not.toHaveAttribute('inert', '');

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test('uses a modal rather than shrinking the main column when a desktop-width viewport cannot fit both regions', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await loginAs(page, 'Maya Levin', '/deals/OPP-1001');
  const citation = page.getByRole('button', { name: /source=slack\/account_team_updates\.tsv, update_id=SLK-9002/ }).first();
  await citation.click();
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Evidence detail' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('preserves complete responsive records at 320px and a short 200%-zoom equivalent', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await loginAs(page, 'Maya Levin');
  await expect(page.getByRole('table', { name: 'Authorized deals' })).toHaveCount(0);
  const dealRecord = page.getByRole('list', { name: 'Authorized deals' }).getByRole('listitem');
  for (const value of ['Northstar Foods Cooperative - Global Access Renewal', '6.0 Order Review', 'Maya Levin', '2026-05-17', '4,217,500', '78%', 'Medium risk', 'No run yet', 'Standard deal']) {
    await expect(dealRecord).toContainText(value);
  }
  await expectNoHorizontalOverflow(page);

  await page.getByRole('link', { name: /Open OPP-1001/ }).click();
  const stakeholder = page.getByRole('list', { name: 'Stakeholders' }).getByRole('listitem').filter({ hasText: 'Elena Voss' });
  await expect(stakeholder).toContainText('Goals');
  await expect(stakeholder).toContainText('None recorded');
  await expect(stakeholder).toContainText('Wants a clean renewal path');
  await expect(page.getByText('4,217,500', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ width: 640, height: 320 });
  const citation = page.getByRole('button', { name: /source=slack\/account_team_updates\.tsv, update_id=SLK-9002/ }).first();
  await citation.click();
  const sheet = page.getByRole('dialog', { name: 'Evidence detail' });
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(316);
  expect(await sheet.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await sheet.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('renders deterministic loading and safe error states at the production route boundary', async ({ page }) => {
  await loginAs(page, 'Maya Levin');
  await page.route('**/api/deals/OPP-1001', async (route) => {
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 350);
    await delay.promise;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'UNAVAILABLE', message: 'Unavailable' }) });
  });
  await page.getByRole('link', { name: /Open OPP-1001/ }).click();
  await expect(page.getByRole('status', { name: 'Loading destination' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This view could not be loaded' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('renders safe empty list and workspace states with a persona recovery path', async ({ page, context }) => {
  await loginAs(page, 'Maya Levin');
  const sessionVersion = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const session = await response.json() as { version: string };
    return session.version;
  });
  const workspaceResponse = await page.evaluate(async () => {
    const response = await fetch('/api/deals/OPP-1001', { credentials: 'same-origin' });
    return response.json();
  });
  await page.route('**/api/deals', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/deals') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessionVersion, deals: [] }) });
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No authorized deals' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review persona access' })).toHaveAttribute('href', '#active-persona-control');
  await expect(page.getByText(/does not reveal hidden deal names or counts/i)).toBeVisible();

  const workspacePage = await context.newPage();
  await workspacePage.route('**/api/deals/OPP-1001', async (route) => {
    const body = workspaceResponse as {
      sourceSnapshot: {
        evidenceOverview: {
          sections: Record<string, { items: string[]; citationIds: string[]; accountTeamUpdateImpact: boolean }>;
        };
      };
    };
    const { evidenceOverview } = body.sourceSnapshot;
    const sectionsWithoutEvidence = Object.fromEntries(Object.entries(evidenceOverview.sections).map(([id, section]) => [
      id, { ...section, items: [], citationIds: [], accountTeamUpdateImpact: false }
    ]));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...body,
      evidence: [],
      sourceSnapshot: {
        ...body.sourceSnapshot,
        evidenceOverview: {
          ...evidenceOverview,
          sections: sectionsWithoutEvidence,
          stakeholders: [],
          actions: [],
          warnings: []
        }
      }
    }) });
  });
  await workspacePage.goto('/deals/OPP-1001');
  await expect(workspacePage.getByRole('heading', { name: 'Stakeholder Map' })).toBeVisible();
  await expect(workspacePage.getByText('No authorized stakeholder records are available.')).toBeVisible();
  await expect(workspacePage.getByText('No deterministic source cues are available.')).toBeVisible();
  await expect(workspacePage.getByRole('button', { name: /Open evidence:/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(workspacePage);
  await workspacePage.close();
});
