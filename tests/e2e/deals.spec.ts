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

test('lists only the signed persona authorized deals and opens the brief-first workspace', async ({ page }) => {
  await loginAs(page, 'Maya Levin');

  await expect(page.getByRole('heading', { name: 'Authorized deals' })).toBeVisible();
  const deals = page.getByRole('table', { name: 'Authorized deals' });
  await expect(deals.getByText('OPP-1001', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('OPP-1002')).toHaveCount(0);
  await expect(page.getByText('OPP-1003')).toHaveCount(0);

  await page.getByRole('link', { name: /Open OPP-1001/ }).click();
  await expect(page).toHaveURL('/deals/OPP-1001');
  await expect(page.getByRole('heading', { level: 1, name: /Northstar Foods Cooperative/ })).toBeVisible();
  await expect(page.getByText('OPP-1001', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Order Review/).first()).toBeVisible();
  await expect(page.getByText(/medium risk/i).first()).toBeVisible();

  for (const section of sections) {
    await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('table', { name: 'Stakeholders' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Recommended actions' })).toBeVisible();
  await expect(page.getByText('Account-team update impact').first()).toBeVisible();
  await expect(page.getByRole('button', {
    name: /source=slack\/account_team_updates\.tsv, update_id=SLK-1001-02/
  }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const historyCitation = page.getByRole('button', {
    name: /source=slack\/account_team_updates\.tsv, update_id=SLK-1001-02/
  }).first();
  await openCitation(page, historyCitation);
  await page.getByRole('button', { name: 'Close evidence detail' }).click();
  await page.goBack();
  await expect(page).toHaveURL('/deals');
});

test('desktop evidence uses one non-modal complementary region with replace and back history', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, 'Maya Levin', '/deals/OPP-1001');

  const first = page.getByRole('button', {
    name: /source=slack\/account_team_updates\.tsv, update_id=SLK-1001-02/
  }).first();
  await openCitation(page, first);

  const detail = page.getByRole('complementary', { name: 'Evidence detail' });
  await expect(detail).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(detail.getByText('slack:SLK-1001-02:0', { exact: true })).toBeVisible();
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

  await page.goBack();
  await expect(page.getByRole('complementary', { name: 'Evidence detail' })).toHaveCount(0);
  await expect(page).toHaveURL('/deals/OPP-1001');

  await openCitation(page, first);
  await page.getByRole('button', { name: 'Close evidence detail' }).click();
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
    name: /source=slack\/account_team_updates\.tsv, update_id=SLK-1001-02/
  }).first();
  await openCitation(page, citation);
  const sheet = page.getByRole('dialog', { name: 'Evidence detail' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Authorized source record and stable citation identifiers.')).toBeVisible();
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox!.height).toBeGreaterThanOrEqual(840);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await expect(page.locator('#main-content')).toHaveAttribute('inert', '');

  await page.keyboard.press('Tab');
  await expect(sheet.getByRole('button', { name: 'Close evidence detail' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(sheet.getByRole('button', { name: 'Close evidence detail' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(citation).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await expectNoHorizontalOverflow(page);

  await page.goto('/deals/OPP-1001?evidence=slack%3ASLK-1001-02%3A0');
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toHaveCount(0);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test('uses a modal rather than shrinking the main column when a desktop-width viewport cannot fit both regions', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await loginAs(page, 'Maya Levin', '/deals/OPP-1001');
  const citation = page.getByRole('button', { name: /source=slack\/account_team_updates\.tsv, update_id=SLK-1001-02/ }).first();
  await citation.click();
  await expect(page.getByRole('dialog', { name: 'Evidence detail' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Evidence detail' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
