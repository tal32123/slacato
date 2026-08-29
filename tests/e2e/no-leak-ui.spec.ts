import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const hiddenTokens = [
  'OPP-1003',
  'Eclipse BioMaterials',
  'restricted-eclipse',
  'SLK-1003',
  'pricing_notes.tsv',
  'account_team_updates.tsv#SLK-1003',
  'liability language',
  'concession statement'
] as const;

async function loginAs(page: Page, name: string, returnTo = '/deals'): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole('button', { name: new RegExp(`Continue as ${name}`) }).click();
  await expect(page).toHaveURL(returnTo);
}

async function expectOpaque(content: string): Promise<void> {
  for (const token of hiddenTokens) expect(content.toLowerCase()).not.toContain(token.toLowerCase());
}

async function sessionApi(request: APIRequestContext, userId: string): Promise<void> {
  const headers = { Origin: 'http://127.0.0.1:4173', 'Sec-Fetch-Site': 'same-site' };
  const csrf = await request.get('/api/auth/csrf', { headers });
  const body = await csrf.json() as { csrfToken: string };
  const selected = await request.post('/api/auth/persona', {
    headers: { ...headers, 'X-CSRF-Token': body.csrfToken },
    data: { userId }
  });
  expect(selected.ok()).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test('unauthorized persona cannot discover the restricted deal through list or direct UI navigation', async ({ page }) => {
  await loginAs(page, 'Harper Noor');
  await expect(page.getByRole('heading', { name: 'Authorized deals' })).toBeVisible();
  await expect(page.getByText('OPP-1001', { exact: true }).first()).toBeVisible();
  await expectOpaque(await page.locator('body').innerText());

  await page.goto('/deals/OPP-1003');
  await expect(page).toHaveURL('/forbidden');
  await expect(page.getByRole('heading', { name: 'This workspace is not available' })).toBeVisible();
  await expectOpaque(await page.locator('body').innerText());
  await expectOpaque(await page.content());
});

test('unauthorized deal APIs return an opaque denial without names, counts, source metadata, snippets, or locators', async ({ request }) => {
  await sessionApi(request, 'USR-5007');
  const headers = { Origin: 'http://127.0.0.1:4173', 'Sec-Fetch-Site': 'same-site' };

  const list = await request.get('/api/deals', { headers });
  expect(list.status()).toBe(200);
  const listText = await list.text();
  await expectOpaque(listText);
  expect(listText).toContain('OPP-1001');

  const denied = await request.get('/api/deals/OPP-1003', { headers });
  expect(denied.status()).toBe(403);
  const deniedText = await denied.text();
  expect(JSON.parse(deniedText)).toEqual({ code: 'FORBIDDEN', message: 'Request could not be authorized' });
  await expectOpaque(deniedText);

  const arbitrary = await request.get('/api/deals/OPP-does-not-exist', { headers });
  expect(arbitrary.status()).toBe(403);
  expect(await arbitrary.json()).toEqual({ code: 'FORBIDDEN', message: 'Request could not be authorized' });
});
