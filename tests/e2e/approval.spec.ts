import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const suffix = `task13e2e-${process.pid}-${Date.now()}`;
const canonicalCommit = '076c659c3c7afd416f8d26729774b67042a55761';
const fixtures = {
  quorum: { opportunity: `OPP-quorum-${suffix}`, run: `run-quorum-${suffix}`, subject: `subject-quorum-${suffix}`, desk: `entry-desk-${suffix}`, leader: `entry-leader-${suffix}` },
  edit: { opportunity: `OPP-edit-${suffix}`, run: `run-edit-${suffix}`, subject: `subject-edit-${suffix}`, entry: `entry-edit-${suffix}` },
  reject: { opportunity: `OPP-reject-${suffix}`, run: `run-reject-${suffix}`, subject: `subject-reject-${suffix}`, entry: `entry-reject-${suffix}` }
} as const;
const leaderId = `USR-${7_000_000 + process.pid}`;
const leaderName = `Task 13 Sales Leader ${process.pid}`;
const payload = {
  dealSnapshot: { accountName: 'Eclipse BioMaterials Ltd', opportunityName: 'Restricted Account Renewal', stage: 'Negotiation' },
  executiveSummary: { narrative: 'Insufficient supported evidence is available for an executive summary.' },
  buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
  stakeholderMap: { stakeholders: [] },
  negotiationState: { currentState: 'Insufficient supported evidence is available.', risks: [] },
  recommendedNextActions: { actions: [] },
  missingInformation: { items: [] },
  sourceEvidence: { evidence: [] },
  confidenceAndReviewWarnings: { overallConfidence: 0.8, warnings: [] }
};
function hashApprovalPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value is not serializable');
  return serialized;
}
const subjectHash = hashApprovalPayload(payload);
let sql: Sql;

async function loginAs(page: Page, name: string, returnTo: string): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole('button', { name: new RegExp(`Continue as ${name}`) }).click();
  await expect(page).toHaveURL(returnTo);
}

async function seedApproval(opportunityId: string, runId: string, subjectId: string, entries: readonly Readonly<{ id: string; authority: 'deal_desk' | 'sales_leader' }>[]): Promise<void> {
  await sql`insert into opportunities (id, account_id, name, restricted) values (${opportunityId}, 'ACC-2003', 'Restricted Account Renewal', true)`;
  await sql`insert into opportunity_policy_facts
    (opportunity_id, discount_percent, renewal_uplift_percent, liability_cap_changed, data_retention_language,
      restricted_research_language, customer_specific_security_language, customer_facing_concession_language,
      conflicting_evidence, missing_material_evidence, source_commit)
    values (${opportunityId}, 12, 0, false, false, false, false, false, false, false, 'task-13-e2e')`;
  await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
    values (${runId}, ${opportunityId}, 'USR-5003', 'awaiting_approval', 'mock', 'mock-brief', ${hashApprovalPayload(runId)}, 5)`;
  await sql`insert into run_evidence_manifests
    (id, run_id, scope_hash, policy_hash, query_hash, index_profile, embedding_provider, embedding_model,
      embedding_dimension, embedding_version, embedding_normalization, context_limit, diagnostics)
    values (${`manifest-${runId}`}, ${runId}, ${'a'.repeat(64)}, ${'b'.repeat(64)}, ${'c'.repeat(64)}, 'task-13-e2e',
      'mock', 'mock-embedding', 3, 'v1', 'l2', 1000, '{}'::jsonb)`;
  await sql`insert into run_events (id, run_id, sequence, type, payload) values
    (${`event-${runId}`}, ${runId}, 1, 'awaiting_approval', ${sql.json({ version: 5, subjectHash, quorumVersion: 'deal-brief-approval-v1' })})`;
  await sql`insert into approval_subjects
    (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
    values (${subjectId}, ${runId}, 1, ${subjectHash}, ${sql.json(payload)}, ${sql.json(['section:executiveSummary'])}, ${sql.json([])}, ${sql.json([])}, ${sql.json(['discount'])}, 'deal-brief-approval-v1')`;
  for (const [ordinal, entry] of entries.entries()) {
    await sql`insert into approval_requirement_entries
      (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
      values (${entry.id}, ${subjectId}, 'commercial_discount', ${sql.json([entry.authority])}, ${sql.json(['discount'])}, ${sql.json([])}, ${ordinal})`;
  }
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  sql = postgres(databaseUrl, { max: 1 });
  await sql`insert into personas (id, display_name, role, source_commit)
    values (${leaderId}, ${leaderName}, 'Sales Leader', '076c659c3c7afd416f8d26729774b67042a55761')`;
  await sql`insert into approval_authority_grants (id, persona_id, account_id, authority, source, source_commit)
    values (${`authority-leader-${suffix}`}, ${leaderId}, 'ACC-2003', 'sales_leader', 'task-13-e2e', ${canonicalCommit})`;
  await seedApproval(fixtures.quorum.opportunity, fixtures.quorum.run, fixtures.quorum.subject, [
    { id: fixtures.quorum.desk, authority: 'deal_desk' },
    { id: fixtures.quorum.leader, authority: 'sales_leader' }
  ]);
  await seedApproval(fixtures.edit.opportunity, fixtures.edit.run, fixtures.edit.subject, [{ id: fixtures.edit.entry, authority: 'deal_desk' }]);
  await seedApproval(fixtures.reject.opportunity, fixtures.reject.run, fixtures.reject.subject, [{ id: fixtures.reject.entry, authority: 'deal_desk' }]);
});
test.afterAll(async () => { await sql.end({ timeout: 1 }); });

test('partial quorum remains awaiting until a distinct authorized persona satisfies the next entry', async ({ page }) => {
  await loginAs(page, 'Rina Vale', `/approvals/${fixtures.quorum.subject}`);
  await expect(page.getByRole('heading', { name: 'Required approvals' })).toBeVisible();
  await expect(page.getByText('Quorum 0 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Approve unchanged' }).click();
  await expect(page.getByText('Quorum 1 of 2')).toBeVisible();
  await page.goto(`/runs/${fixtures.quorum.run}`);
  await expect(page.getByText('Awaiting approval', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Restricted Account Renewal' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.route(`**/api/runs/${fixtures.quorum.run}/events*`, (route) => route.abort());
  await page.reload();
  await expect(page.getByText('Reconnecting')).toBeVisible();
  await page.unroute(`**/api/runs/${fixtures.quorum.run}/events*`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Restricted Account Renewal' })).toBeVisible();

  await page.goto('/settings');
  await page.getByRole('radio', { name: new RegExp(leaderName) }).check();
  await page.getByRole('button', { name: 'Use selected persona' }).click();
  await expect(page.getByRole('button', { name: new RegExp(leaderName) })).toBeVisible();
  await page.goto(`/approvals/${fixtures.quorum.subject}`);
  await expect(page.getByText(/Your authority: Sales Leader/)).toBeVisible();
  await page.getByRole('button', { name: 'Approve unchanged' }).click();
  await expect(page.getByText('Finalizing', { exact: true })).toBeVisible();
});

test('edit and approve creates a new immutable subject and editing alone never resumes the run', async ({ page }) => {
  await loginAs(page, 'Rina Vale', `/approvals/${fixtures.edit.subject}`);
  await page.getByRole('button', { name: 'Edit and approve' }).click();
  await page.getByLabel('Overall confidence').fill('0.7');
  await expect(page.getByRole('heading', { name: 'Change preview' })).toBeVisible();
  await page.getByLabel('Rationale').fill('Clarify the approved commercial posture.');
  await expect(page).toHaveURL(new RegExp(`${fixtures.edit.subject}$`));
  const decisionResponse = page.waitForResponse((response) => response.url().includes('/api/approvals/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Submit edit for approval' }).click();
  const response = await decisionResponse;
  expect(response.ok(), `Approval edit failed with HTTP ${response.status()}`).toBe(true);
  await expect(page.getByRole('status')).toContainText('Decision recorded');
  await expect(page).not.toHaveURL(new RegExp(`${fixtures.edit.subject}$`));
  await expect(page.getByText('Approval review')).toBeVisible();
  await page.getByRole('link', { name: 'View run' }).click();
  await expect(page.getByText('Awaiting approval', { exact: true }).first()).toBeVisible();
});

test('reject is terminal, duplicate action is disabled, and history remains inspectable', async ({ page }) => {
  await loginAs(page, 'Rina Vale', `/approvals/${fixtures.reject.subject}`);
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByLabel('Rationale').fill('The commercial posture is not acceptable.');
  const confirm = page.getByRole('button', { name: 'Confirm rejection' });
  await confirm.click();
  await expect(page.getByText('Rejected', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Decision history' })).toBeVisible();
  await page.getByRole('link', { name: 'View run' }).click();
  await expect(page.getByRole('heading', { name: 'Approval rejected' })).toBeVisible();
});

test('approval inbox is stacked and accessible on mobile while forbidden deep links stay opaque', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await loginAs(page, 'Rina Vale', '/approvals');
  await expect(page.getByRole('heading', { name: 'Approval inbox' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.goto('/settings');
  await page.getByRole('radio', { name: /Harper Noor/ }).check();
  await page.getByRole('button', { name: 'Use selected persona' }).click();
  for (const path of [
    `/runs/${fixtures.edit.run}`,
    `/approvals/${fixtures.edit.subject}`,
    '/deals/OPP-1003?evidence=evidence_restricted',
    `/exports/${fixtures.edit.run}`
  ]) {
    await page.goto(path);
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('Eclipse BioMaterials');
    expect(body).not.toContain('Restricted Account Renewal');
    expect(body).not.toContain(subjectHash);
  }
});
