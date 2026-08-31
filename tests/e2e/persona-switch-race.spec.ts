import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, name = 'Maya Levin', returnTo = '/settings'): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole('button', { name: new RegExp(`Continue as ${name}`) }).click();
  await expect(page).toHaveURL(returnTo);
}

/**
 * Regression coverage for a race between the Settings persona-switch mutation and the app shell.
 *
 * `sessionRuntime.prepareTransition()` used to blank the ENTIRE app shell (replacing it with
 * `<RoutePending/>`, unmounting the Settings page and its persona radios) for as long as the
 * persona-switch mutation was in flight -- from the moment the button was pressed until a second,
 * redundant `/api/auth/session` refetch (triggered by `revalidator.revalidate()`) resolved. On a
 * small/fast database this window was invisible; on a larger, aged database (or, as reproduced
 * here, any sufficiently slow/loaded backend) the window widened past what a real user -- or this
 * test -- would wait before continuing to interact with the page, so the page underneath their
 * hands disappeared into a blank pending screen and reappeared, or timed out, whenever the network
 * happened to settle. That is a real correctness/availability defect, not just test flakiness: a
 * user on a slow connection could watch their own Settings page vanish out from under them for an
 * unbounded, backend-latency-dependent amount of time after clicking a button that already shows
 * its own "Changing persona…" affordance.
 *
 * This test widens that window with an artificial response delay (in place of an aged database)
 * and asserts the Settings page and its controls remain mounted and interactive throughout --
 * exactly what a user would expect from a page that already renders its own busy state. It fails
 * against the unfixed code with "element(s) not found" once the delay exceeds the assertion
 * timeout, and passes once `prepareTransition` no longer blanks the shell for this self-initiated,
 * same-page transition.
 */
test('settings page stays mounted and interactive while a slow persona-switch mutation is in flight', async ({
  page
}) => {
  await loginAs(page);

  // Stand in for a slow/bloated database: delay only the persona-switch mutation's response, well
  // past Playwright's default 5s expect timeout, so the test cannot pass by accident on a fast
  // reply.
  await page.route('**/api/auth/persona', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await route.continue();
  });

  await page.getByRole('radio', { name: /Nora Chen/ }).check();
  await page.getByRole('button', { name: 'Use selected persona' }).click();

  // The mutation is still in flight (the throttle has not released it yet). The page must not
  // have been replaced by a global pending screen: the radios stay in the DOM and reflect the
  // user's in-progress selection, and the button reports that it is working, all without waiting
  // for the network.
  await expect(page.getByRole('radio', { name: /Nora Chen/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /Maya Levin/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Changing persona…' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Persona & session' })).toBeVisible();

  // Let the throttled mutation resolve and confirm the switch still completes normally.
  await expect(page.getByRole('button', { name: 'Use selected persona' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Nora Chen, active persona')).toBeVisible();
});
