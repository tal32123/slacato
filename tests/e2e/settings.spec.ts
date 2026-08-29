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
  for (const heading of [
    'Read permission',
    'Can access restricted opportunities',
    'Can view sensitive pricing',
    'Request permission',
    'Account Owner',
    'Sales Leader',
    'Deal Desk',
    'Legal Reviewer'
  ]) {
    await expect(matrix.getByRole('columnheader', { name: heading })).toBeVisible();
  }
  await expect(page.getByText('Output mode')).toBeVisible();
  await expect(page.getByText('Pinned generation model')).toBeVisible();
  await expect(page.getByText('Pinned embedding model')).toBeVisible();
  await expect(page.getByText('Index health')).toBeVisible();
  await expect(page.getByText('Runtime readiness')).toBeVisible();
  await expect(page.getByText('Runtime not configured')).toBeVisible();
  const representativeRow = matrix.getByRole('row', { name: /ACC-2001 Gong summary/ });
  await expect(representativeRow.getByRole('cell')).toHaveText([
    'ACC-2001',
    'Gong summary',
    'Yes',
    'No',
    'No',
    'Yes',
    'Yes',
    'No',
    'No',
    'No'
  ]);

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMatrix = page.getByRole('list', { name: 'Permission and decision authority matrix' });
  await expect(mobileMatrix).toBeVisible();
  const mobileRecord = mobileMatrix.getByRole('listitem').filter({ hasText: 'Gong summary' });
  await expect(mobileRecord.locator('dt, dd')).toHaveText([
    'Read permission',
    'Yes',
    'Can access restricted opportunities',
    'No',
    'Can view sensitive pricing',
    'No',
    'Request permission',
    'Yes',
    'Account Owner authority',
    'Yes',
    'Sales Leader authority',
    'No',
    'Deal Desk authority',
    'No',
    'Legal Reviewer authority',
    'No'
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('rejects diagnostics from a different session version and refetches before render', async ({ page }) => {
  await loginAs(page);
  let attempts = 0;
  await page.route('**/api/diagnostics', async (route) => {
    attempts += 1;
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(page.url()).origin, 'sec-fetch-site': 'same-origin' } });
    if (attempts === 1) {
      const payload = await response.json() as Record<string, unknown>;
      await route.fulfill({
        response,
        contentType: 'application/json',
        body: JSON.stringify({ ...payload, sessionVersion: '00000000-0000-4000-8000-000000000000' })
      });
      return;
    }
    await route.fulfill({ response });
  });
  await page.getByLabel('Session controls').getByRole('link', { name: 'Demo Diagnostics' }).click();
  await expect(page.getByRole('heading', { name: 'Demo Diagnostics' })).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test('stops after one diagnostics reconciliation retry and surfaces stable recovery', async ({ page }) => {
  await loginAs(page);
  let attempts = 0;
  await page.route('**/api/diagnostics', async (route) => {
    attempts += 1;
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: new URL(page.url()).origin, 'sec-fetch-site': 'same-origin' }
    });
    const payload = await response.json() as Record<string, unknown>;
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify({ ...payload, sessionVersion: '00000000-0000-4000-8000-000000000000' })
    });
  });

  await page.getByLabel('Session controls').getByRole('link', { name: 'Demo Diagnostics' }).click();
  await expect(page).toHaveURL('/diagnostics');
  await expect(page.getByRole('heading', { name: 'This view could not be loaded' })).toBeVisible();
  expect(attempts).toBe(2);
  await page.waitForTimeout(250);
  expect(attempts).toBe(2);
});

test('rejects diagnostics completed by a stale connection generation', async ({ page }) => {
  await loginAs(page);
  let attempts = 0;
  let releaseRequest: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  await page.route('**/api/diagnostics', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      markStarted?.();
      await new Promise<void>((resolve) => { releaseRequest = resolve; });
    }
    await route.continue();
  });
  const navigation = page.goto('/diagnostics').catch(() => null);
  await started;
  await page.evaluate(async () => {
    // Preserve only the intercepted request so its stale generation reaches the response gate.
    const { queryClient, sessionRuntime } = await import('/src/api/session.ts');
    const session = queryClient.getQueryData(['session']) as { authenticated: boolean; version?: string } | undefined;
    if (!session?.authenticated || session.version === undefined) throw new Error('Expected an authenticated session');
    sessionRuntime.prepareTransition(['scoped', session.version, 'diagnostics']);
  });
  releaseRequest?.();
  await navigation;
  await expect(page.getByRole('heading', { name: 'Demo Diagnostics' })).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test('reconciles authoritative persona and logout cookies after invalid mutation bodies', async ({ page, context }) => {
  await loginAs(page);
  const observingTab = await context.newPage();
  await observingTab.goto('/settings');

  await page.route('**/api/auth/persona', async (route) => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(page.url()).origin, 'sec-fetch-site': 'same-origin' } });
    await route.fulfill({ response, contentType: 'application/json', body: '{' });
  });
  await page.getByRole('radio', { name: /Owen Patel/ }).check();
  await page.getByRole('button', { name: 'Use selected persona' }).click();
  await expect(page.getByRole('radio', { name: /Owen Patel/ })).toBeChecked();
  await expect(observingTab.getByRole('radio', { name: /Owen Patel/ })).toBeChecked();
  await expect(page.getByText('Maya Levin, active persona')).toHaveCount(0);

  await page.unroute('**/api/auth/persona');
  await page.route('**/api/auth/logout', async (route) => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(page.url()).origin, 'sec-fetch-site': 'same-origin' } });
    await route.fulfill({ response, contentType: 'application/json', body: '{' });
  });
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(observingTab).toHaveURL(/\/login/);
  await observingTab.close();
});

test('keeps sibling tabs authenticated when rejected persona and logout mutations leave the cookie unchanged', async ({ page, context }) => {
  await loginAs(page);
  const observingTab = await context.newPage();
  await observingTab.goto('/settings');

  await page.route('**/api/auth/persona', async (route) => {
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'INVALID_CSRF', message: 'Request could not be authorized' })
    });
  });
  await page.getByRole('radio', { name: /Owen Patel/ }).check();
  await page.getByRole('button', { name: 'Use selected persona' }).click();
  await expect(page).toHaveURL('/settings');
  await expect(observingTab).toHaveURL('/settings');
  await expect(page.getByRole('radio', { name: /Maya Levin/ })).toBeChecked();
  await expect(observingTab.getByRole('radio', { name: /Maya Levin/ })).toBeChecked();

  await page.unroute('**/api/auth/persona');
  await page.route('**/api/auth/logout', async (route) => {
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'INVALID_CSRF', message: 'Request could not be authorized' })
    });
  });
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL('/settings');
  await expect(observingTab).toHaveURL('/settings');
  await expect(page.getByRole('radio', { name: /Maya Levin/ })).toBeChecked();
  await expect(observingTab.getByRole('radio', { name: /Maya Levin/ })).toBeChecked();
  await observingTab.close();
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
