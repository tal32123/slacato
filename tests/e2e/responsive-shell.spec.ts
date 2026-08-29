import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

const destinations = ['Deals', 'Runs', 'Approvals', 'Settings'] as const;

async function loginAs(page: Page, name = 'Maya Levin', returnTo = '/settings'): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole('button', { name: new RegExp(`Continue as ${name}`) }).click();
  await expect(page).toHaveURL(returnTo);
}

async function tabTo(page: Page, target: Locator, limit = 30): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  await expect(target).toBeFocused();
}

test.describe.configure({ mode: 'serial' });

test('adapts one primary navigation across the required responsive viewports', async ({ page }) => {
  await loginAs(page);
  const viewports = [
    { name: '320 phone', width: 320, height: 720, mobile: true },
    { name: '390 phone', width: 390, height: 844, mobile: true },
    { name: '768 tablet', width: 768, height: 1024, mobile: true },
    { name: 'landscape phone', width: 844, height: 390, mobile: true },
    { name: '200% zoom equivalent', width: 640, height: 450, mobile: true },
    { name: '1024 desktop', width: 1024, height: 768, mobile: false },
    { name: 'short desktop', width: 1024, height: 600, mobile: false },
    { name: '1440 desktop', width: 1440, height: 900, mobile: false }
  ] as const;

  for (const viewport of viewports) {
    await test.step(viewport.name, async () => {
      await page.setViewportSize(viewport);
      const primary = page.getByRole('navigation', { name: 'Primary' });
      await expect(primary).toBeVisible();
      await expect(primary).toHaveAttribute('data-layout', viewport.mobile ? 'mobile' : 'desktop');
      for (const label of destinations) {
        const link = primary.getByRole('link', { name: label, exact: true });
        await expect(link).toBeVisible();
        const box = await link.boundingBox();
        expect(box, `${label} must have a rendered target`).not.toBeNull();
        expect(box!.height, `${label} touch target height`).toBeGreaterThanOrEqual(44);
        expect(box!.width, `${label} touch target width`).toBeGreaterThanOrEqual(44);
      }
      const undersizedTargets = await page.evaluate(() => {
        const radioLabels = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
          .map((radio) => radio.closest('label'))
          .filter((label): label is HTMLLabelElement => label !== null);
        const targets = new Set<Element>([...document.querySelectorAll('a, button'), ...radioLabels]);
        return [...targets].flatMap((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden') return [];
          if (rect.width >= 44 && rect.height >= 44) return [];
          return [{ name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName, width: rect.width, height: rect.height }];
        });
      });
      expect(undersizedTargets, 'every visible control or radio label must provide a 44px target').toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'must not overflow horizontally').toBe(true);
    });
  }
});

test('completes the desktop and mobile shell journey with keyboard input only', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/diagnostics');
  await expect(page).toHaveURL('/unauthorized?returnTo=%2Fdiagnostics');

  const choosePersona = page.getByRole('link', { name: 'Choose a persona' });
  await tabTo(page, choosePersona);
  await page.keyboard.press('Enter');
  const mayaLogin = page.getByRole('button', { name: /Continue as Maya Levin/ });
  await tabTo(page, mayaLogin);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/diagnostics');

  const skip = page.getByRole('link', { name: 'Skip to content' });
  await tabTo(page, skip);
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  const personaMenu = page.getByRole('button', { name: /Maya Levin, Account Owner/ });
  await expect(personaMenu).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Persona & session' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Demo Diagnostics' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(personaMenu).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  const railToggle = page.getByRole('button', { name: 'Expand navigation' });
  await expect(railToggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(railToggle).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('navigation', { name: 'Secondary' }).getByRole('link', { name: 'Demo Diagnostics' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  const settings = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings', exact: true });
  await expect(settings).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/settings');

  const mayaRadio = page.getByRole('radio', { name: /Maya Levin/ });
  await tabTo(page, mayaRadio);
  await page.keyboard.press('ArrowDown');
  const noraRadio = page.getByRole('radio', { name: /Nora Chen/ });
  await expect(noraRadio).toBeChecked();
  await page.keyboard.press('Space');
  await page.keyboard.press('Shift+Tab');
  const changePersona = page.getByRole('button', { name: 'Use selected persona' });
  await expect(changePersona).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('radio', { name: /Nora Chen/ })).toBeChecked();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/deals');
  const mobileDeals = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Deals', exact: true });
  await tabTo(page, mobileDeals);
  await page.keyboard.press('Tab');
  const mobileRuns = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Runs', exact: true });
  await expect(mobileRuns).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/runs');
});

test('initializes and toggles the exact desktop rail widths across breakpoints', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await loginAs(page);
  const rail = page.getByRole('complementary');
  await expect(rail).toHaveAttribute('data-state', 'collapsed');
  expect((await rail.boundingBox())?.width).toBe(72);

  await page.getByRole('button', { name: 'Expand navigation' }).click();
  await expect(rail).toHaveAttribute('data-state', 'expanded');
  expect((await rail.boundingBox())?.width).toBe(240);
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  expect((await rail.boundingBox())?.width).toBe(72);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(rail).toHaveAttribute('data-state', 'expanded');
  expect((await rail.boundingBox())?.width).toBe(240);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(rail).toHaveAttribute('data-state', 'collapsed');
  expect((await rail.boundingBox())?.width).toBe(72);
});

test('announces exact Diagnostics location on desktop and containing Settings location on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await loginAs(page, 'Maya Levin', '/diagnostics');
  const desktopPrimary = page.getByRole('navigation', { name: 'Primary' });
  await expect(desktopPrimary.getByRole('link', { name: 'Settings', exact: true })).not.toHaveAttribute('aria-current');
  const diagnostics = page.getByRole('navigation', { name: 'Secondary' }).getByRole('link', { name: 'Demo Diagnostics' });
  await expect(diagnostics).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileSettings = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings', exact: true });
  await expect(mobileSettings).toHaveAttribute('aria-current', 'location');
});

test('foreground-refetches the signed session on protected navigation', async ({ page }) => {
  await loginAs(page);
  let sessionRequests = 0;
  await page.route('**/api/auth/session', async (route) => {
    sessionRequests += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }) });
  });
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Runs', exact: true }).click();
  await expect(page).toHaveURL('/unauthorized?returnTo=%2Fruns');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  expect(sessionRequests).toBeGreaterThan(0);
});

test('routes typed authorization errors and gives root bootstrap failures a main landmark', async ({ page }) => {
  await loginAs(page);
  await page.route('**/api/diagnostics', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'UNAUTHORIZED', message: 'Authentication is required' })
  }));
  await page.goto('/diagnostics');
  await expect(page).toHaveURL('/login?returnTo=%2Fdiagnostics');

  await page.unroute('**/api/diagnostics');
  await page.goto('/settings');
  await page.route('**/api/diagnostics', (route) => route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'FORBIDDEN', message: 'Request could not be authorized' })
  }));
  await page.goto('/diagnostics');
  await expect(page).toHaveURL('/forbidden');

  await page.unroute('**/api/diagnostics');
  await page.route('**/api/auth/session', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto('/runs');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'This view could not be loaded' })).toBeVisible();
});

test('renders route pending, error, and genuine not-found states', async ({ page }) => {
  await loginAs(page);

  let releaseDiagnostics: (() => void) | undefined;
  await page.route('**/api/diagnostics', async (route) => {
    await new Promise<void>((resolve) => { releaseDiagnostics = resolve; });
    await route.continue();
  });
  await page.getByLabel('Session controls').getByRole('link', { name: 'Demo Diagnostics' }).click();
  await expect(page.getByRole('status', { name: 'Loading destination' })).toBeVisible();
  releaseDiagnostics?.();
  await expect(page.getByRole('heading', { name: 'Demo Diagnostics' })).toBeVisible();
  await page.unroute('**/api/diagnostics');

  await page.goto('/not-a-real-destination');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByText('not-a-real-destination')).toHaveCount(0);

  await page.route('**/api/diagnostics', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto('/diagnostics');
  await expect(page.getByRole('heading', { name: 'This view could not be loaded' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('has no automated accessibility violations in mobile and desktop shells', async ({ page }) => {
  await loginAs(page);
  for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  }
});

test('respects forced colors and reduced motion while preserving visible focus', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await loginAs(page);
  const deals = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Deals', exact: true });
  await tabTo(page, deals);
  const styles = await deals.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      outlineStyle: computed.outlineStyle,
      outlineWidth: Number.parseFloat(computed.outlineWidth),
      transitionSeconds: Number.parseFloat(computed.transitionDuration)
    };
  });
  expect(styles.outlineStyle).toBe('solid');
  expect(styles.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(styles.transitionSeconds).toBeLessThanOrEqual(0.001);
});
