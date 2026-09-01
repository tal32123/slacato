import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';

/**
 * Covers what a reviewer sees after a run fails, end to end.
 *
 * Reported live, twice. First: a run failed mid-tour and "only at the end i get the highlight as
 * to why" -- the workflow classified the failure, but the code travelled on the `fail` event and
 * nothing read it afterwards, so every screen could say a run failed and none could say what
 * failed. Second: a run URL "couldn't open" while the tour was active on the step that narrates a
 * run; the page was loaded and its API healthy, but the tour had not found its target yet and its
 * no-target fallback sealed the viewport behind an opaque, click-swallowing sheet.
 *
 * Both paths are asserted against a real browser here because both are about what reaches the
 * screen: the unit tests pin the copy and the projection, not whether a reader can see or reach
 * them. The run is seeded through SQL rather than generated, the pattern the other run specs use
 * -- a real failing generation is neither deterministic nor free.
 */

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const suffix = `${process.pid}-${Date.now()}`;
const personaId = `USR-${8_100_000 + process.pid}`;
const personaName = `Failure Reason Runner ${process.pid}`;
const accountId = `ACC-failreason-${suffix}`;
const opportunityId = `OPP-failreason-${suffix}`;
const runId = `run-failreason-${suffix}`;
const SOURCE_COMMIT = '076c659c3c7afd416f8d26729774b67042a55761';
const STORAGE_KEY = 'slacato.guided-tour.v3';
/**
 * Index of the step that narrates a run (`run-progress-detail`). Hardcoded for the same reason
 * tour-robustness.spec.ts hardcodes its own: the tour module cannot be imported into Playwright's
 * plain Node runner. The title assertion below fails loudly if the step order moves, rather than
 * letting this quietly exercise a different step.
 */
const RUN_STEP_INDEX = 3;
const RUN_STEP_TITLE = 'Watch the work actually happen';
const SHOTS = process.env.E2E_SHOT_DIR;

let sql: Sql;

/** Signs in through the real login UI, revealing the non-canonical fixture identities first. */
async function loginAs(page: Page, name: string, returnTo: string): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByText('Other fixture identities', { exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`Continue as ${name}`) }).click();
  await expect(page).toHaveURL(returnTo);
}

/** Places the guided tour on a chosen step for the next page load. */
async function armTourAt(page: Page, stepIndex: number): Promise<void> {
  await page.evaluate(
    ([key, index]) =>
      window.localStorage.setItem(
        key as string,
        JSON.stringify({ active: true, stepIndex: index as number, dismissed: true })
      ),
    [STORAGE_KEY, stepIndex] as const
  );
}

/** Saves a screenshot for review when the runner asked for one. */
async function shoot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  sql = postgres(databaseUrl, { max: 1 });
  await sql`insert into accounts (id, name) values (${accountId}, 'Failure Reason Account')`;
  await sql`insert into opportunities (id, account_id, name, restricted)
    values (${opportunityId}, ${accountId}, 'Failure Reason Renewal', false)`;
  await sql`insert into personas (id, display_name, role, source_commit)
    values (${personaId}, ${personaName}, 'Account Owner', ${SOURCE_COMMIT})`;
  await sql`insert into permission_grants
    (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_request_approval,
      can_approve, sensitive_pricing, source_commit)
    values (${`grant-failreason-${suffix}`}, ${personaId}, ${accountId}, 'salesforce', true, false,
      true, false, false, ${SOURCE_COMMIT})`;
  await sql`insert into runs
    (id, opportunity_id, requested_by, status, generation_provider, generation_model,
      start_request_hash, version)
    values (${runId}, ${opportunityId}, ${personaId}, 'failed', 'mock', 'mock-brief',
      ${'d'.repeat(64)}, 3)`;
  // The shape the workflow actually publishes: a `fail` event carrying `reasonCode`. This is the
  // only place the diagnostic code exists, which is precisely why the run detail has to project it.
  await sql`insert into run_events (id, run_id, sequence, type, payload) values
    (${`event-failreason-created-${suffix}`}, ${runId}, 1, 'run_created',
      ${sql.json({ status: 'created', deadlineMs: 60_000 })}),
    (${`event-failreason-synth-${suffix}`}, ${runId}, 2, 'specialists_completed',
      ${sql.json({ version: 2, status: 'validating' })}),
    (${`event-failreason-fail-${suffix}`}, ${runId}, 3, 'fail',
      ${sql.json({ version: 3, reasonCode: 'draft_validation_failed', terminal: true })})`;
});

test.afterAll(async () => {
  await sql.end({ timeout: 1 });
});

test('the run page names what stopped a failed run, not just that it stopped', async ({ page }) => {
  await loginAs(page, personaName, `/runs/${runId}`);

  const notice = page.getByRole('complementary').filter({ hasText: 'Run failed safely' });
  await expect(notice).toBeVisible();
  // The projected code, in the words the interface uses -- not a raw enum, and not silence.
  await expect(notice).toContainText('did not pass validation');
  await expect(notice).toContainText('retries ran out');
  await shoot(page, '01-run-page-failure-reason');
});

test('the guided tour reports the same reason on the step that narrates the run', async ({
  page
}) => {
  await loginAs(page, personaName, `/runs/${runId}`);
  await armTourAt(page, RUN_STEP_INDEX);
  await page.reload();

  await expect(page.getByRole('heading', { name: RUN_STEP_TITLE })).toBeVisible();
  const gate = page.getByRole('status').filter({ hasText: 'This run failed' });
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('did not pass validation');
  await expect(gate).toContainText('produced no brief');
  // Holding a reviewer on a step whose run can never reach the narrated outcome is the failure
  // this replaced, so the way onward has to be live.
  await expect(page.getByRole('button', { name: /Next/ })).toBeEnabled();
  await shoot(page, '02-tour-failure-reason');
});

test('a step whose target is absent leaves the page readable and clickable', async ({ page }) => {
  // The reported "the view couldn't open": the run step's target does not exist on the deals
  // list, so the tour has nothing to frame. Its no-target fallback used to be a full-viewport
  // opaque sheet that swallowed every click, which is indistinguishable from a broken page.
  await loginAs(page, personaName, '/deals');
  await armTourAt(page, RUN_STEP_INDEX);
  await page.reload();

  await expect(page.getByRole('heading', { name: RUN_STEP_TITLE })).toBeVisible();
  await expect(page.getByText(/not ready on screen yet/)).toBeVisible();
  await shoot(page, '03-tour-no-target-page-readable');

  // A real click on a real control underneath must reach it rather than being absorbed.
  const dealLink = page.getByRole('link', { name: `Open ${opportunityId} workspace` });
  const box = await dealLink.boundingBox();
  if (box === null) throw new Error('Expected the seeded deal to be listed');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(page).toHaveURL(`/deals/${opportunityId}`);
});
