import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const suffix = `${process.pid}-${Date.now()}`;
const personaId = `USR-${8_000_000 + process.pid}`;
const personaName = `Task 13 Runner ${process.pid}`;
const accountId = `ACC-task13-run-${suffix}`;
const opportunityId = `OPP-task13-run-${suffix}`;
let sql: Sql;

async function loginAs(page: Page, name: string, returnTo: string): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole('button', { name: new RegExp(`Continue as ${name}`) }).click();
  await expect(page).toHaveURL(returnTo);
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  sql = postgres(databaseUrl, { max: 1 });
  await sql`insert into accounts (id, name) values (${accountId}, 'Task 13 Run Account')`;
  await sql`insert into opportunities (id, account_id, name, restricted) values (${opportunityId}, ${accountId}, 'Task 13 Stable Run', false)`;
  await sql`insert into personas (id, display_name, role, source_commit)
    values (${personaId}, ${personaName}, 'Account Owner', '076c659c3c7afd416f8d26729774b67042a55761')`;
  await sql`insert into permission_grants
    (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval, can_approve, sensitive_pricing, source_commit)
    values (${`grant-task13-run-${suffix}`}, ${personaId}, ${accountId}, 'salesforce', true, false, true, false, false, '076c659c3c7afd416f8d26729774b67042a55761')`;
});
test.afterAll(async () => { await sql.end({ timeout: 1 }); });

test('deal generation is single-submit, redirects to a stable run, and refresh rejoins its persisted watermark', async ({ page }) => {
  await loginAs(page, personaName, `/deals/${opportunityId}`);
  let startRequests = 0;
  let releaseStart: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { releaseStart = resolve; });
  await page.route('**/api/runs/deal-brief', async (route) => {
    startRequests += 1;
    await blocked;
    await route.continue();
  });

  const generate = page.getByRole('button', { name: 'Generate Brief' });
  await generate.click();
  await expect(page.getByRole('button', { name: 'Starting brief…' })).toBeDisabled();
  await page.getByRole('button', { name: 'Starting brief…' }).dispatchEvent('click');
  expect(startRequests).toBe(1);
  releaseStart?.();

  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
  const runUrl = page.url();
  await expect(page.getByText(/Last updated/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Task 13 Stable Run' })).toBeVisible();

  const detail = await page.evaluate(async () => {
    const runId = location.pathname.split('/').at(-1);
    const response = await fetch(`/api/runs/${encodeURIComponent(runId ?? '')}/detail`, { credentials: 'same-origin' });
    return response.json() as Promise<{ runId: string; watermark: string | null; watermarkSequence: number }>;
  });
  expect(detail.watermarkSequence).toBeGreaterThanOrEqual(1);

  await page.reload();
  await expect(page).toHaveURL(runUrl);
  await expect(page.getByText('Persisted timeline')).toBeVisible();
  await page.getByRole('link', { name: 'Back to runs' }).click();
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Rejoin|View/ }).first()).toBeVisible();
});

test('run view reports offline recovery, closes on persona transition, and keeps forbidden deep links opaque', async ({ page, context }) => {
  await loginAs(page, personaName, '/runs');
  const firstRun = page.getByRole('link', { name: /Rejoin|View/ }).first();
  await firstRun.click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
  await expect(page.getByText('Persisted timeline')).toBeVisible();
  const runUrl = new URL(page.url()).pathname;
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(/Reconnecting|Live|Connecting/, { exact: true })).toBeVisible();

  const observing = await context.newPage();
  await observing.goto(runUrl);
  await expect(observing.getByText('Persisted timeline')).toBeVisible();
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Harper Noor/ }).check();
  await page.getByRole('button', { name: 'Use selected persona' }).click();
  await expect(page.getByRole('button', { name: /Harper Noor/ })).toBeVisible();
  await observing.waitForLoadState('domcontentloaded');
  await observing.goto(runUrl);
  const body = await observing.locator('body').innerText();
  await expect(observing.getByRole('heading', { name: 'This view could not be loaded' })).toBeVisible();
  expect(body).not.toContain('Task 13 Stable Run');
  expect(body).not.toContain(accountId);
  expect(body).not.toContain('ACC-2001');
});

test('run experiences are responsive and have no automated accessibility violations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, personaName, '/runs');
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
