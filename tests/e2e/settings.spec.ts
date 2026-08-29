import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, name = 'Maya Levin', returnTo = '/settings'): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole('button', { name: new RegExp(`Continue as ${name}`) }).click();
  await expect(page).toHaveURL(returnTo);
}

test.describe.configure({ mode: 'serial' });

test('keeps Settings scoped to signed persona and session controls', async ({ page }) => {
  await loginAs(page);
  await expect(page.getByRole('heading', { name: 'Persona & session' })).toBeVisible();
  await expect(page.getByText('Signed demo session')).toBeVisible();
  await expect(page.getByRole('radio', { name: /Maya Levin/ })).toBeChecked();
  await expect(page.getByLabel('Session controls').getByRole('link', { name: 'Demo Diagnostics' })).toBeVisible();
  await expect(page.getByText(/model|index health|permission matrix/i)).toHaveCount(0);
});

test('shows truthful read-only permission and runtime diagnostics with seller-assist copy', async ({ page }) => {
  await loginAs(page, 'Maya Levin', '/diagnostics');
  await expect(page.getByRole('heading', { name: 'Demo Diagnostics' })).toBeVisible();
  await expect(page.getByText('Read-only')).toBeVisible();
  await expect(page.getByText(/negotiation-preparation assistant/i)).toBeVisible();
  await expect(page.getByText(/internal, evidence-backed suggestions/i)).toBeVisible();
  await expect(page.getByText(/sellers own judgment/i)).toBeVisible();
  await expect(page.getByText(/no control autonomously sends customer-facing content/i)).toBeVisible();

  const matrix = page.getByRole('table', { name: 'Permission and decision authority matrix' });
  await expect(matrix).toBeVisible();
  for (const heading of ['Request permission', 'Account Owner', 'Sales Leader', 'Deal Desk', 'Legal Reviewer']) {
    await expect(matrix.getByRole('columnheader', { name: heading })).toBeVisible();
  }
  await expect(page.getByText('Output mode')).toBeVisible();
  await expect(page.getByText('Pinned generation model')).toBeVisible();
  await expect(page.getByText('Pinned embedding model')).toBeVisible();
  await expect(page.getByText('Index health')).toBeVisible();
  await expect(page.getByText('Runtime readiness')).toBeVisible();

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('list', { name: 'Permission and decision authority matrix' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('closes streams and overlays, changes persona across tabs, and clears stale identity before rendering', async ({ page, context }) => {
  await loginAs(page);
  const observingTab = await context.newPage();
  await observingTab.goto('/settings');
  await expect(observingTab.getByRole('radio', { name: /Maya Levin/ })).toBeChecked();

  await observingTab.evaluate(async () => {
    // The Node-hosted test cannot statically import the browser's live Vite module instance.
    const { sessionRuntime } = await import('/src/api/session.ts');
    sessionStorage.setItem('task11-stream-closed', '0');
    sessionStorage.setItem('task11-overlay-closed', '0');
    sessionRuntime.registerStream({
      close: () => sessionStorage.setItem('task11-stream-closed', '1')
    });
    sessionRuntime.registerOverlayCloser(() => sessionStorage.setItem('task11-overlay-closed', '1'));
  });

  await page.getByRole('radio', { name: /Rina Vale/ }).check();
  await page.getByRole('button', { name: 'Use selected persona' }).click();
  await expect(page.getByRole('radio', { name: /Rina Vale/ })).toBeChecked();
  await expect(observingTab.getByRole('radio', { name: /Rina Vale/ })).toBeChecked();
  await expect(observingTab.getByText('Maya Levin, active persona')).toHaveCount(0);
  expect(await observingTab.evaluate(() => sessionStorage.getItem('task11-stream-closed'))).toBe('1');
  expect(await observingTab.evaluate(() => sessionStorage.getItem('task11-overlay-closed'))).toBe('1');

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL('/login');
  await expect(observingTab).toHaveURL('/login');
  await observingTab.close();
});

test('logs out from the persona menu without leaving protected content rendered', async ({ page }) => {
  await loginAs(page);
  await page.getByRole('button', { name: /Maya Levin, Account Owner/ }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { name: 'Persona & session' })).toHaveCount(0);
});
