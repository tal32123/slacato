import { expect, test } from '@playwright/test';

test('keyboard persona login and persona switching update the authenticated workspace', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Choose your demo persona' })).toBeVisible();
  await expect(page.locator('[data-slot="card-title"]', { hasText: 'Maya Levin' })).toBeVisible();
  await expect(page.getByText('No passwords. No invented roles.')).toBeVisible();

  const maya = page.getByRole('button', { name: /Continue as Maya Levin/ });
  await maya.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: /Welcome, Maya/ })).toBeVisible();

  await page.getByRole('link', { name: 'Change persona' }).click();
  await page.getByRole('button', { name: /Continue as Owen Patel/ }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: /Welcome, Owen/ })).toBeVisible();

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { name: 'Choose your demo persona' })).toBeVisible();
});

test('CSRF and exact browser-origin protections reject hostile mutations', async ({ request }) => {
  const headers = { 'Sec-Fetch-Site': 'same-origin' };
  const bootstrap = await request.get('/api/auth/csrf', { headers });
  expect(bootstrap.ok()).toBe(true);
  const { csrfToken } = await bootstrap.json() as { csrfToken: string };

  const missingCsrf = await request.post('/api/auth/persona', {
    headers: { ...headers, Origin: 'http://127.0.0.1:4173' },
    data: { userId: 'USR-5001' }
  });
  expect(missingCsrf.status()).toBe(403);
  expect(await missingCsrf.json()).toEqual({ code: 'INVALID_CSRF', message: 'Request could not be authorized' });

  const hostile = await request.post('/api/auth/persona', {
    headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://hostile.example', 'X-CSRF-Token': csrfToken },
    data: { userId: 'USR-5001' }
  });
  expect(hostile.status()).toBe(403);

  const arbitrary = await request.post('/api/auth/persona', {
    headers: { ...headers, Origin: 'http://127.0.0.1:4173', 'X-CSRF-Token': csrfToken },
    data: { userId: 'USR-9999' }
  });
  expect(arbitrary.status()).toBe(403);
  expect(JSON.stringify(await arbitrary.json())).not.toContain('USR-9999');

  const inventedRole = await request.post('/api/auth/persona', {
    headers: { ...headers, Origin: 'http://127.0.0.1:4173', 'X-CSRF-Token': csrfToken },
    data: { userId: 'USR-5001', role: 'Administrator' }
  });
  expect(inventedRole.status()).toBe(400);
});

test('login and denial routes remain usable on a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: /Continue as Nora Chen/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.goto('/unauthorized');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await page.goto('/forbidden');
  await expect(page.getByRole('heading', { name: 'This workspace is not available' })).toBeVisible();
});
