import { expect, test } from '@playwright/test';
import { expectOpaque, loginAs } from './support/personas';

const STORAGE_KEY = 'slacato.guided-tour.v3';
// Mirrors tourSteps.length in apps/web/src/components/guided-tour.tsx. Not imported directly:
// that module pulls in React/react-router/lucide-react component code meant to run through the
// web app's Vite alias and JSX toolchain, not Playwright's plain Node test runner. If the guided
// tour's step count changes, update this constant (and the fixed step indices used below).
const TOTAL_STEPS = 20;

async function startTourAsMaya(page: import('@playwright/test').Page): Promise<void> {
  await loginAs(page, 'Maya Levin', '/deals');
  await page.evaluate(() => window.dispatchEvent(new Event('slacato:start-guided-tour')));
  await expect(page).toHaveURL('/login');
  await page.getByRole('button', { name: /Continue as Maya Levin/ }).click();
  await expect(page).toHaveURL('/deals');
  await expect(page.getByText(`Step 2 of ${TOTAL_STEPS}`)).toBeVisible();
}

test.describe('guided tour: click containment', () => {
  test('the dimmed backdrop blocks pointer clicks outside the highlighted target', async ({ page }) => {
    await startTourAsMaya(page);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL('/deals/OPP-1001');
    await expect(page.getByText(`Step 3 of ${TOTAL_STEPS}`)).toBeVisible();

    const settingsLink = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Settings', exact: true });
    const box = await settingsLink.boundingBox();
    if (box === null) throw new Error('Expected the primary Settings nav link to be present');
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // A real click at the coordinates of a nav link the spotlight does not highlight must be
    // absorbed by the dimmed overlay, not reach the link underneath.
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(150);
    await expect(page).toHaveURL('/deals/OPP-1001');
    await expect(page.getByRole('dialog')).toBeVisible();

    // Prove the assertion above is not vacuous: with the overlay's pointer-events disabled, the
    // identical click must reach the link and navigate.
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('.pointer-events-auto').forEach((el) => {
        if (el.className.includes('bg-brand-forest')) el.style.pointerEvents = 'none';
      });
    });
    await page.mouse.click(point.x, point.y);
    await expect(page).toHaveURL('/settings');
  });
});

test.describe('guided tour: step navigation edge cases', () => {
  test('rapid double-click on Next advances exactly one step, not two', async ({ page }) => {
    await startTourAsMaya(page);
    await page.getByRole('button', { name: 'Next' }).dblclick();
    await expect(page.getByText(`Step 3 of ${TOTAL_STEPS}`)).toBeVisible();
    await expect(page.getByText(`Step 4 of ${TOTAL_STEPS}`)).not.toBeVisible();
  });

  test('Back from the first non-required step returns to the required login step and its route', async ({ page }) => {
    await startTourAsMaya(page);
    // Step index 1 (deal-list) has a Back button; step index 0 (Maya's persona card) requires an
    // interaction instead and shows no Next/Back pair at all -- Back must still land there cleanly.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL('/login');
    await expect(page.getByRole('dialog', { name: 'Sign in as the deal owner' })).toBeVisible();
    await expect(page.getByText('Choose "Continue as Maya Levin" to continue.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
  });

  test('reloading mid-tour resumes at the same step and route from persisted state', async ({ page }) => {
    await startTourAsMaya(page);
    await page.reload();
    await expect(page).toHaveURL('/deals');
    await expect(page.getByText(`Step 2 of ${TOTAL_STEPS}`)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Only the deals this person may see' })).toBeVisible();
  });

  test('starting the tour from a mid-flow deep link always restarts at step one', async ({ page }) => {
    await loginAs(page, 'Maya Levin', '/deals/OPP-1001');
    await page.evaluate(() => window.dispatchEvent(new Event('slacato:start-guided-tour')));
    await expect(page).toHaveURL('/login');
    await expect(page.getByText(`Step 1 of ${TOTAL_STEPS}`)).toBeVisible();
  });

  test('a hard navigation away from the current step snaps back to its route; browser Back/Forward do not', async ({
    page
  }) => {
    // A user cannot click a real link on the underlying page to leave the current step: the
    // previous test proves the dimmed backdrop blocks exactly that (the primary nav's own
    // "Settings" link, even though it renders normally, is unreachable by mouse while a
    // non-required step's spotlight is up). The two ways a step's route can actually change from
    // under the tour are a hard navigation (typed URL, bookmark, full reload) and browser
    // Back/Forward -- and they behave differently, because a hard navigation remounts the app and
    // resets the "already routed this step" ref that browser history traversal does not touch.
    await startTourAsMaya(page);

    await page.goto('/settings');
    // The remounted tour re-reads its persisted step (still index 1, deal-list) and re-fires its
    // routing effect, sending the browser straight back to that step's own route.
    await expect(page).toHaveURL('/deals');
    await expect(page.getByText(`Step 2 of ${TOTAL_STEPS}`)).toBeVisible();

    // Browser Back replays that navigation as an in-app history change (no remount), which the
    // tour does not force-revert: the user actually lands on, and stays on, /settings.
    await page.goBack();
    await expect(page).toHaveURL('/settings');
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL('/deals');
    await expect(page.getByText(`Step 2 of ${TOTAL_STEPS}`)).toBeVisible();
  });
});

test.describe('guided tour: keyboard and dismissal', () => {
  test('Escape closes the tour and returns focus to the launcher button', async ({ page }) => {
    await startTourAsMaya(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The launcher renames itself once there is a position to come back to, so the focus target
    // is the resume control rather than a fresh start it would no longer perform.
    await expect(
      page.getByRole('button', { name: `Resume guided tour at step 2 of ${TOTAL_STEPS}` })
    ).toBeFocused();
  });
});

test.describe('guided tour: permission mismatch mid-flow', () => {
  test('the spotlight refuses a persona the step did not name, and an unauthorized persona reaching a restricted step leaks nothing', async ({
    page
  }) => {
    // This test used to prove graceful degradation by clicking a DIFFERENT persona at the switch
    // gate (settings.tsx advances the tour on any successful switch, not specifically the narrated
    // one). That click is no longer possible by mouse: the spotlight frames one persona card, so
    // the dimmed backdrop now absorbs a click on any other. Both halves are asserted here -- the
    // containment, and the degradation, which is still reachable by resuming the tour at a
    // restricted step while signed in as a persona who cannot read that deal.
    await loginAs(page, 'Harper Noor', '/settings');
    await page.evaluate(
      (key) => window.localStorage.setItem(key, JSON.stringify({ active: true, stepIndex: 6, dismissed: false })),
      STORAGE_KEY
    );
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Select the restricted deal owner' })).toBeVisible();

    // A persona the step did not name sits behind the backdrop and cannot be selected.
    const other = page.getByRole('radio', { name: /Owen Patel/ });
    const otherBox = await other.boundingBox();
    if (otherBox === null) throw new Error('Expected an unnarrated persona radio to be rendered');
    await page.mouse.click(otherBox.x + otherBox.width / 2, otherBox.y + otherBox.height / 2);
    await page.waitForTimeout(150);
    await expect(other).not.toBeChecked();
    await expect(page.getByRole('heading', { name: 'Select the restricted deal owner' })).toBeVisible();

    // The persona the step DID name is reachable, so the step is completable rather than locked.
    const narrated = page.getByRole('radio', { name: /Nora Chen/ });
    const narratedBox = await narrated.boundingBox();
    if (narratedBox === null) throw new Error('Expected the narrated persona radio to be rendered');
    await page.mouse.click(narratedBox.x + narratedBox.width / 2, narratedBox.y + narratedBox.height / 2);
    await expect(narrated).toBeChecked();
    await expect(page.getByRole('heading', { name: 'Apply the persona change' })).toBeVisible();

    // Harper is still the signed-in persona. Resuming the tour at the restricted deal's own step
    // puts a persona with no permission on a step whose route she cannot read.
    await page.evaluate(
      (key) => window.localStorage.setItem(key, JSON.stringify({ active: true, stepIndex: 8, dismissed: false })),
      STORAGE_KEY
    );
    await page.reload();

    // The loader denies the narrated route and redirects to the opaque permission boundary -- no
    // crash, no blank spotlight, and no leaked deal identity -- and the tour offers a way onward
    // instead of dead-ending. This assertion also guards a regression found while fixing the
    // spotlight: a query observer the tour kept mounted on every screen disturbed the protected
    // loaders enough to turn this clean denial into a generic "could not be loaded" error.
    await expect(page).toHaveURL('/forbidden');
    await expect(page.getByRole('heading', { name: 'This workspace is not available' })).toBeVisible();
    expectOpaque(await page.locator('body').innerText());

    const continueAnyway = page.getByRole('button', { name: 'Continue anyway' });
    await expect(continueAnyway).toBeEnabled();
    await continueAnyway.click();
    await expect(page.getByText(`Step 10 of ${TOTAL_STEPS}`)).toBeVisible();
  });
});

test.describe('guided tour: the spotlight frames one control', () => {
  test('the login step lights only the named persona and the backdrop blocks the others', async ({
    page
  }) => {
    // Reported: "if i need to click on maya, it should only highlight maya and everything else
    // gray". Narrowing the target is only half the fix -- the dimmed backdrop must now cover the
    // persona cards that used to sit inside the highlighted region.
    await page.goto('/login');
    await page.evaluate(() => window.dispatchEvent(new Event('slacato:start-guided-tour')));
    await expect(page.getByText(`Step 1 of ${TOTAL_STEPS}`)).toBeVisible();

    const maya = page.locator('[data-tour="persona-USR-5001"]');
    await expect(maya).toHaveAttribute('data-tour-active', 'true');
    await expect(maya).toContainText('Maya Levin');
    await expect(maya).not.toContainText('Nora Chen');

    // A different persona's sign-in button now sits behind the backdrop: clicking where it renders
    // must not sign anyone in.
    const other = page.getByRole('button', { name: /Continue as Nora Chen/ });
    const box = await other.boundingBox();
    if (box === null) throw new Error('Expected a second persona card to be present on /login');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(150);
    await expect(page).toHaveURL('/login');
    await expect(page.getByText(`Step 1 of ${TOTAL_STEPS}`)).toBeVisible();

    // The spotlighted persona is still reachable, so the step is completable rather than merely locked.
    await page.getByRole('button', { name: /Continue as Maya Levin/ }).click();
    await expect(page).toHaveURL('/deals');
    await expect(page.getByText(`Step 2 of ${TOTAL_STEPS}`)).toBeVisible();
  });
});

test.describe('guided tour: following an instruction is progress, not a detour', () => {
  test('opening the deal workspace the step names advances instead of warning', async ({ page }) => {
    // Reported: "it tells me i'm on wrong place when i clicked what it wanted".
    await startTourAsMaya(page);
    await expect(page.getByRole('heading', { name: 'Only the deals this person may see' })).toBeVisible();

    await page.getByRole('link', { name: 'Open OPP-1001 workspace' }).first().click();

    await expect(page).toHaveURL('/deals/OPP-1001');
    await expect(page.getByText(`Step 3 of ${TOTAL_STEPS}`)).toBeVisible();
    await expect(page.getByText(/stepped off the guided path/)).toHaveCount(0);
  });
});

// There is deliberately no end-to-end test of the run-state gate here. Asserting it needs a run in
// a non-terminal state, and this suite has no worker, so the only way to get one is to start a real
// run -- which writes a row into the database every spec in this suite shares, changing OPP-1001's
// "Latest run" out from under deals.spec.ts. Stubbing the run endpoints instead would assert the
// shape of the stub rather than the server's. The gate is covered deterministically in
// tests/unit/guided-tour-precision.test.ts, where the run state can be staged directly: it holds
// while the run works, releases on the state the step narrates, releases with an honest notice on a
// failed run, and always offers a deliberate way onward.

test.describe('guided tour: the dialog never covers the control it names', () => {
  /**
   * Measures the step dialog and the spotlit target as real rectangles, in a real browser.
   *
   * A screenshot cannot answer this question -- the failure is a 30px overlap that looks fine and
   * silently swallows the tap -- so the assertion is geometric, plus a hit test at the exact
   * point a user's finger would land.
   */
  async function measureStepOne(page: import('@playwright/test').Page) {
    return await page.evaluate(() => {
      const dialog = document.querySelector('[data-tour-dialog="true"]');
      const target = document.querySelector('[data-tour-active="true"]');
      if (dialog === null || target === null) throw new Error('Expected a spotlit target and a step dialog');
      const d = dialog.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      const button = target.querySelector('button');
      if (button === null) throw new Error('Expected the spotlit persona card to contain its own button');
      const b = button.getBoundingClientRect();
      const point = { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        overlaps: d.left < t.right && d.right > t.left && d.top < t.bottom && d.bottom > t.top,
        tapReachesButton: hit !== null && (button === hit || button.contains(hit)),
        buttonOnScreen: b.top >= 0 && b.bottom <= window.innerHeight
      };
    });
  }

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 }
  ]) {
    // 390x844 is the exact-boundary case: the persona card's centre lands on 422 and half the
    // viewport is also 422, so the old "which half is the centre in?" rule answered "upper",
    // pinned the dialog to the bottom edge, and laid it over "Continue as Maya Levin" -- on a
    // step that requires that click and therefore offers no Next to escape by.
    test(`step one keeps its own button clear and tappable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await loginAs(page, 'Maya Levin', '/deals');
      await page.evaluate(() => window.dispatchEvent(new Event('slacato:start-guided-tour')));
      await expect(page).toHaveURL('/login');
      await expect(page.getByText(`Step 1 of ${TOTAL_STEPS}`)).toBeVisible();

      const measured = await measureStepOne(page);

      expect(measured.overlaps).toBe(false);
      expect(measured.buttonOnScreen).toBe(true);
      expect(measured.tapReachesButton).toBe(true);
    });
  }
});

test.describe('guided tour: leaving and coming back', () => {
  test('Escape then the launcher resumes the same step instead of restarting at step one', async ({ page }) => {
    // Reported from a live walkthrough: Escape at step 14 cost thirteen steps, two persona
    // switches and a recorded approval decision, because the launcher always called settle(0)
    // -- and closing also hides the invitation banner, so the launcher was the only way back.
    await startTourAsMaya(page);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL('/deals/OPP-1001');
    await expect(page.getByText(`Step 3 of ${TOTAL_STEPS}`)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const launcher = page.getByRole('button', { name: `Resume guided tour at step 3 of ${TOTAL_STEPS}` });
    await expect(launcher).toBeFocused();

    await launcher.click();

    await expect(page.getByText(`Step 3 of ${TOTAL_STEPS}`)).toBeVisible();
    await expect(page).toHaveURL('/deals/OPP-1001');
    // Closing deliberately silences the invitation banner; resuming must not undo that.
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), STORAGE_KEY))
      .toEqual({ active: true, stepIndex: 2, dismissed: true });
  });

  test('"Start over" is the deliberate way back to step one', async ({ page }) => {
    await startTourAsMaya(page);
    await page.getByRole('button', { name: 'Start over' }).click();

    await expect(page).toHaveURL('/login');
    await expect(page.getByText(`Step 1 of ${TOTAL_STEPS}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start over' })).toHaveCount(0);
  });
});
