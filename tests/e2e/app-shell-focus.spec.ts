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

/**
 * Regression coverage for the guided tour's flakiest CI failure ("Escape then the launcher
 * resumes the same step", tour-robustness.spec.ts), which failed on trees byte-identical to ones
 * that had just passed -- run 33515204336 against the very same tree as the passing 33514800961.
 *
 * The shell defers its route-change focus move to an animation frame, so the new route's content
 * exists to focus into. A frame is not produced on any schedule a loaded CI runner is obliged to
 * keep, so that focus move can land arbitrarily late -- after something else has deliberately
 * claimed focus. Closing the guided tour does exactly that: it returns focus to its launcher on
 * the commit that closes (deliberately not on a frame -- see aa5cc30). The navigation that opened
 * the step then stole focus straight back to <main>, stranding a keyboard user with no way to
 * resume, and reading in CI as "launcher present, correctly labelled, never focused".
 *
 * Route-change focus is a default for when nothing else claims focus, not an override of one that
 * did. Holding frames is the assertion: the contract must hold however late the frame lands.
 */
test('a route-change focus frame that lands late does not steal focus claimed since', async ({
  page
}) => {
  await page.addInitScript(() => {
    const queue = new Map<number, FrameRequestCallback>();
    let nextId = 1 << 20;
    let holding = false;
    const real = window.requestAnimationFrame.bind(window);
    const realCancel = window.cancelAnimationFrame.bind(window);
    Object.assign(window, {
      __holdFrames: () => {
        holding = true;
      },
      __flushFrames: () => {
        holding = false;
        const pending = [...queue.values()];
        queue.clear();
        for (const cb of pending) cb(performance.now());
      }
    });
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      if (!holding) return real(cb);
      const id = nextId++;
      queue.set(id, cb);
      return id;
    }) as typeof window.requestAnimationFrame;
    // Held frames must still be cancellable, or the stub runs callbacks a real browser would
    // have dropped and the test asserts against a situation that cannot occur.
    window.cancelAnimationFrame = ((id: number) => {
      if (!queue.delete(id)) realCancel(id);
    }) as typeof window.cancelAnimationFrame;
  });

  await loginAs(page, 'Maya Levin', '/deals');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const main = page.locator('#main-content');
  const launcher = page.locator('[data-tour="tour-launcher"]');

  // From here the runner produces no frames, so the shell's route-focus stays pending.
  await page.evaluate(() => (window as unknown as { __holdFrames: () => void }).__holdFrames());

  await nav.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL('/settings');

  // Something else deliberately claims focus while that frame is still owed.
  await launcher.focus();
  await expect(launcher).toBeFocused();

  await page.evaluate(() => (window as unknown as { __flushFrames: () => void }).__flushFrames());

  await expect(launcher).toBeFocused();
  await expect(main).not.toBeFocused();
});
