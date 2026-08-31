import { expect, test } from '@playwright/test';
import { loginAs } from './support/personas';

/**
 * Regression coverage for commit 220e722 ("fix: stop stranding keyboard focus after a
 * back-then-forward navigation"), apps/web/src/components/app-shell.tsx.
 *
 * The shell used to record `previouslyFocusedPathname` on every navigation, including ones where
 * it deliberately skips moving focus (a POP / browser-history navigation, or a navigation carrying
 * `state.focusOwner === 'approval-status'`). That made the *next* real navigation back to the same
 * path look unchanged, so <main> never received focus and a keyboard user was stranded on the nav
 * link they had just activated, needing to tab through the entire nav again to reach content.
 *
 * Repro that only a real browser can exercise (not covered by the component's own jsdom unit
 * tests, which do not model real History back/forward):
 *   1. Land on /deals (PUSH from login) -- focus moves to <main>.
 *   2. Navigate to /settings (PUSH) -- focus moves to <main> again.
 *   3. Browser Back to /deals (POP) -- focus is correctly NOT moved.
 *   4. Click the "Deals" nav link (PUSH to /deals, the same path we are already on) -- the bug
 *      left `pathnameChanged` false here, so <main> was never focused.
 */
test('a nav-link click back to the current path after a browser-Back still moves focus to main content', async ({
  page
}) => {
  await loginAs(page, 'Maya Levin', '/deals');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const main = page.locator('#main-content');

  await nav.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL('/settings');
  await expect(main).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL('/deals');

  // Deliberately move focus elsewhere so the next assertion cannot pass by accident (main content
  // was never re-focused by the POP, which is correct, but this makes that visible instead of
  // silently inheriting focus from the previous step).
  await nav.getByRole('link', { name: 'Deals', exact: true }).focus();
  await expect(main).not.toBeFocused();

  await nav.getByRole('link', { name: 'Deals', exact: true }).click();
  await expect(page).toHaveURL('/deals');
  await expect(main).toBeFocused();
});
