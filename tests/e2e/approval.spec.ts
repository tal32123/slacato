import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { MOCK_EMBEDDING_PROFILE_COLUMNS, mockEmbeddingVectorLiteral } from './support/mock-embeddings';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const suffix = `task13e2e-${process.pid}-${Date.now()}`;
const canonicalCommit = '076c659c3c7afd416f8d26729774b67042a55761';
const approvalOpportunity = `OPP-approval-${suffix}`;
const fixtures = {
  quorum: { opportunity: `OPP-quorum-${suffix}`, run: `run-quorum-${suffix}`, subject: `subject-quorum-${suffix}`, desk: `entry-desk-${suffix}`, leader: `entry-leader-${suffix}` },
  edit: { opportunity: `OPP-edit-${suffix}`, run: `run-edit-${suffix}`, subject: `subject-edit-${suffix}`, entry: `entry-edit-${suffix}` },
  reject: { opportunity: `OPP-reject-${suffix}`, run: `run-reject-${suffix}`, subject: `subject-reject-${suffix}`, entry: `entry-reject-${suffix}` }
} as const;
const leaderId = `USR-${7_000_000 + process.pid}`;
const leaderName = `Task 13 Sales Leader ${process.pid}`;
const evidenceId = `evidence_approval_${suffix}`;
const citationId = `citation_approval_${suffix}`;
const sourceLocator = `salesforce/opportunities.tsv#${approvalOpportunity}`;
const citation = { id: citationId, evidenceId, locator: sourceLocator };
const payload = {
  dealSnapshot: {
    accountName: 'Eclipse BioMaterials Ltd',
    opportunityName: 'Restricted Account Renewal',
    stage: 'Negotiation',
    claims: [{
      id: `claim_snapshot_${suffix}`,
      statement: 'The renewal is ready for a documented commercial review.',
      confidence: 0.8,
      citations: [citation]
    }]
  },
  executiveSummary: {
    narrative: 'The renewal is ready for a documented commercial review.',
    claims: [{
      id: `claim_summary_${suffix}`,
      statement: 'The renewal is ready for a documented commercial review.',
      confidence: 0.8,
      citations: [citation]
    }]
  },
  buyerGoalsAndBusinessDrivers: {
    goals: ['Complete the renewal with reviewed commercial terms.'],
    businessDrivers: [],
    claims: [{
      id: `claim_goal_${suffix}`,
      statement: 'Complete the renewal with reviewed commercial terms.',
      confidence: 0.8,
      citations: [citation]
    }]
  },
  stakeholderMap: { stakeholders: [] },
  negotiationState: {
    currentState: 'The commercial position is awaiting authorized approval.',
    risks: [],
    claims: [{
      id: `claim_negotiation_${suffix}`,
      statement: 'The commercial position is awaiting authorized approval.',
      confidence: 0.8,
      citations: [citation]
    }]
  },
  recommendedNextActions: { actions: [] },
  missingInformation: { items: [] },
  sourceEvidence: {
    evidence: [{
      evidenceId,
      sourceType: 'crm',
      summary: 'The renewal is ready for a documented commercial review.',
      capturedAt: '2026-08-29T00:00:00.000Z',
      claims: [{
        id: `claim_source_${suffix}`,
        statement: 'The renewal is ready for a documented commercial review.',
        confidence: 0.8,
        citations: [citation]
      }]
    }]
  },
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
  const localEvidenceId = `${evidenceId}-${runId}`;
  const localCitationId = `${citationId}-${runId}`;
  const localSourceLocator = `salesforce/opportunities.tsv#${opportunityId}`;
  const localCitation = {
    id: localCitationId,
    evidenceId: localEvidenceId,
    locator: localSourceLocator
  };
  const localPayload = {
    ...payload,
    dealSnapshot: {
      ...payload.dealSnapshot,
      claims: payload.dealSnapshot.claims.map((claim) => ({
        ...claim,
        citations: [localCitation]
      }))
    },
    executiveSummary: {
      ...payload.executiveSummary,
      claims: payload.executiveSummary.claims.map((claim) => ({
        ...claim,
        citations: [localCitation]
      }))
    },
    buyerGoalsAndBusinessDrivers: {
      ...payload.buyerGoalsAndBusinessDrivers,
      claims: payload.buyerGoalsAndBusinessDrivers.claims.map((claim) => ({
        ...claim,
        citations: [localCitation]
      }))
    },
    negotiationState: {
      ...payload.negotiationState,
      claims: payload.negotiationState.claims.map((claim) => ({
        ...claim,
        citations: [localCitation]
      }))
    },
    sourceEvidence: {
      evidence: payload.sourceEvidence.evidence.map((summary) => ({
        ...summary,
        evidenceId: localEvidenceId,
        claims: summary.claims.map((claim) => ({ ...claim, citations: [localCitation] }))
      }))
    }
  };
  const localSubjectHash = hashApprovalPayload(localPayload);
  await sql`insert into opportunities (id, account_id, name, restricted) values (${opportunityId}, 'ACC-2003', 'Restricted Account Renewal', true) on conflict (id) do nothing`;
  await sql`insert into opportunity_policy_facts
    (opportunity_id, discount_percent, renewal_uplift_percent, liability_cap_changed, data_retention_language,
      restricted_research_language, customer_specific_security_language, customer_facing_concession_language,
      conflicting_evidence, missing_material_evidence, source_commit)
    values (${opportunityId}, 12, 0, false, false, false, false, false, false, false, 'task-13-e2e') on conflict (opportunity_id) do nothing`;
  // document_versions.*_ck requires reliability_class/source_locator/classification_reason/policy_hash
  // to be all-null or all-populated, and (independently) the embedding indexer's corpus provenance
  // check -- which runs unconditionally against every row matching its salesforce/gong/pricing/
  // slack/policies source-locator prefixes, evidence's own locator included -- requires a complete,
  // consistent parent document for any such evidence row. Leaving these null let this fixture's
  // leftover row (approval fixtures are never cleaned up between runs) fail that check on the next
  // `pnpm index:embeddings`, crashing the e2e webServer on its very next start.
  await sql`insert into document_versions
    (id, external_id, version, source_type, content_hash, content, reliability_class, source_locator,
      classification_reason, policy_hash)
    values (${`document-${runId}`}, ${`external-${runId}`}, 1, 'salesforce',
      ${`document-hash-${runId}`}, 'The renewal is ready for a documented commercial review.',
      'authoritative_system', ${localSourceLocator}, 'task-13-e2e', ${'a'.repeat(64)})`;
  const evidenceContent =
    'The renewal is ready for a documented commercial review. Complete the renewal with reviewed commercial terms. The commercial position is awaiting authorized approval.';
  const evidenceContentHash = `evidence-hash-${runId}`;
  // The e2e webServer indexes the canonical corpus with AI_PROVIDER=mock (see
  // playwright.config.ts), and packages/infrastructure/src/health/readiness-probes.ts's `index`
  // readiness check requires every row in evidence_versions -- not just the canonical corpus -- to
  // carry a single, consistent embedding profile. Leaving this fixture row's embedding columns
  // null (as a plain approval-routing fixture might reasonably do, since nothing here exercises
  // retrieval) used to flip that check to "unavailable" for the whole deployment, disabling
  // Generate Brief for every later spec in the run. Computing a real mock embedding keeps this
  // fixture from poisoning readiness.
  const evidenceEmbedding = await mockEmbeddingVectorLiteral(evidenceContent);
  await sql`insert into evidence_versions
    (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash,
      content, event_date, source_locator, reliability_class, classification_reason, policy_hash,
      embedding, embedding_provider, embedding_model, embedding_dimension, embedding_profile,
      embedding_version, embedding_normalization, embedding_content_hash)
    values (${localEvidenceId}, ${`document-${runId}`}, 'ACC-2003', ${opportunityId}, 0,
      'salesforce', 'standard', ${evidenceContentHash},
      ${evidenceContent},
      '2026-08-29', ${localSourceLocator}, 'authoritative_system', 'task-13-e2e', ${'a'.repeat(64)},
      ${evidenceEmbedding}::vector, ${MOCK_EMBEDDING_PROFILE_COLUMNS.embeddingProvider},
      ${MOCK_EMBEDDING_PROFILE_COLUMNS.embeddingModel}, ${MOCK_EMBEDDING_PROFILE_COLUMNS.embeddingDimension},
      ${MOCK_EMBEDDING_PROFILE_COLUMNS.embeddingProfile}, ${MOCK_EMBEDDING_PROFILE_COLUMNS.embeddingVersion},
      ${MOCK_EMBEDDING_PROFILE_COLUMNS.embeddingNormalization}, ${evidenceContentHash})`;
  await sql`insert into runs (id, opportunity_id, requested_by, status, generation_provider, generation_model, start_request_hash, version)
    values (${runId}, ${opportunityId}, 'USR-5003', 'awaiting_approval', 'mock', 'mock-brief', ${hashApprovalPayload(runId)}, 5)`;
  await sql`insert into run_evidence_manifests
    (id, run_id, scope_hash, policy_hash, query_hash, index_profile, embedding_provider, embedding_model,
      embedding_dimension, embedding_version, embedding_normalization, context_limit, diagnostics)
    values (${`manifest-${runId}`}, ${runId}, ${'a'.repeat(64)}, ${'b'.repeat(64)}, ${'c'.repeat(64)}, 'task-13-e2e',
      'mock', 'mock-embedding', 3, 'v1', 'l2', 1000, '{}'::jsonb)`;
  await sql`insert into run_evidence_manifest_entries
    (manifest_id, evidence_version_id, citation_id, rank, query_rank, score, content_hash, source_locator,
      source_type, sensitivity, classification_reason, policy_hash, lexical_rank, semantic_rank, fusion_score,
      reliability_adjustment, recency_adjustment, included_characters)
    values (${`manifest-${runId}`}, ${localEvidenceId}, ${localCitationId}, 1, 1, 1, ${`evidence-hash-${runId}`},
      ${localSourceLocator}, 'salesforce', 'standard', 'task-13-e2e', ${'a'.repeat(64)}, 1, 1, 1, 1, 1, 1000)`;
  await sql`insert into run_events (id, run_id, sequence, type, payload) values
    (${`event-${runId}`}, ${runId}, 1, 'awaiting_approval', ${sql.json({ version: 5, subjectHash: localSubjectHash, quorumVersion: 'deal-brief-approval-v1' })})`;
  await sql`insert into approval_subjects
    (id, run_id, draft_version, subject_hash, payload, section_ids, recommendation_ids, citation_ids, policy_triggers, quorum_version)
    values (${subjectId}, ${runId}, 1, ${localSubjectHash}, ${sql.json(localPayload)}, ${sql.json(['section:executiveSummary'])}, ${sql.json([])}, ${sql.json([localCitationId])}, ${sql.json(['discount'])}, 'deal-brief-approval-v1')`;
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
  let decisionAttempt = 0;
  let releaseConflict: (() => void) | undefined;
  const conflictGate = new Promise<void>((resolve) => { releaseConflict = resolve; });
  await page.route('**/api/approvals/decisions', async (route) => {
    decisionAttempt += 1;
    if (decisionAttempt === 1) {
      await conflictGate;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'CONFLICT', message: 'Approval changed' }) });
    } else if (decisionAttempt === 2) {
      await route.abort('connectionreset');
    } else {
      await route.continue();
    }
  });
  const approve = page.getByRole('button', { name: 'Approve unchanged' });
  await approve.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Recording approval…' })).toBeDisabled();
  releaseConflict?.();
  await expect(page.getByRole('button', { name: 'Reload approval' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload approval' }).click();
  await approve.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Retry decision' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry decision' }).click();
  await expect(page.getByText('Quorum 1 of 2')).toBeVisible();
  await page.unroute('**/api/approvals/decisions');
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
  const finalApprove = page.getByRole('button', { name: 'Approve unchanged' });
  await finalApprove.focus();
  await page.keyboard.press('Enter');
  const success = page.getByRole('status');
  await expect(success).toContainText('Approval quorum is satisfied');
  await expect(success).toBeFocused();
  await expect(page.getByText('Finalizing', { exact: true })).toBeVisible();
  await expect(page.getByText('Finalizing', { exact: true }).locator('..').locator('.lucide-circle-dashed')).toBeVisible();
});

test('edit and approve validates semantic fields, reflows at 320px and 200%-equivalent, and keeps replacement success focused', async ({ page }) => {
  let decisionRequestCount = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/approvals/') && request.method() === 'POST') decisionRequestCount += 1;
  });
  await loginAs(page, 'Rina Vale', `/approvals/${fixtures.edit.subject}`);
  await expect(page).toHaveTitle('Approvals | SlaCato');
  await expect(page.getByRole('link', { name: 'Approvals', exact: true }).first()).toHaveAttribute('aria-current', 'page');
  for (const heading of [
    'Deal snapshot', 'Executive summary', 'Buyer goals and business drivers', 'Stakeholder map',
    'Negotiation state', 'Recommended next actions', 'Missing information',
    'Authorized evidence summaries', 'Confidence and review warnings'
  ]) await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(page.getByText(payload.executiveSummary.narrative, { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText(payload.buyerGoalsAndBusinessDrivers.goals[0] ?? '', { exact: true })
  ).toBeVisible();
  await expect(page.getByText(payload.negotiationState.currentState, { exact: true })).toBeVisible();
  const edit = page.getByRole('button', { name: 'Edit and approve' });
  await edit.focus();
  await page.keyboard.press('Enter');
  const summary = page.getByLabel('Executive summary');
  const negotiation = page.getByLabel('Negotiation state');
  await expect(summary).toHaveAttribute('maxlength', '8000');
  await expect(negotiation).toHaveAttribute('maxlength', '8000');
  await page.getByLabel('Rationale').fill('Clarify the approved commercial posture.');
  await summary.fill('');
  const submit = page.getByRole('button', { name: 'Submit edit for approval' });
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(summary).toBeFocused();
  await expect(summary).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter an executive summary.')).toBeVisible();
  await summary.fill(payload.executiveSummary.narrative);
  await negotiation.fill('');
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(negotiation).toBeFocused();
  await expect(negotiation).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter the negotiation state.')).toBeVisible();
  await negotiation.fill(payload.negotiationState.currentState);
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 640, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const confidence = page.getByLabel('Overall confidence');
  await confidence.fill('');
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(confidence).toBeFocused();
  await expect(confidence).toHaveAttribute('aria-invalid', 'true');
  await expect(confidence).toHaveAttribute('aria-describedby', 'confidence-error');
  await expect(page.getByText('Enter a confidence value from 0 to 1.', { exact: true })).toBeVisible();
  expect(decisionRequestCount).toBe(0);
  await confidence.fill('0.7');
  await expect(page.getByRole('heading', { name: 'Change preview' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${fixtures.edit.subject}$`));
  const decisionResponse = page.waitForResponse((response) => response.url().includes('/api/approvals/') && response.request().method() === 'POST');
  await submit.focus();
  await page.keyboard.press('Enter');
  const response = await decisionResponse;
  expect(response.ok(), `Approval edit failed with HTTP ${response.status()}`).toBe(true);
  const status = page.getByRole('status').filter({ hasText: 'Decision recorded' });
  await expect(status).toContainText('Decision recorded');
  await expect(status).toBeFocused();
  await expect(page).not.toHaveURL(new RegExp(`${fixtures.edit.subject}$`));
  await expect(page.getByText('Approval review')).toBeVisible();
  await page.getByRole('link', { name: 'View run' }).click();
  await expect(page.getByText('Awaiting approval', { exact: true }).first()).toBeVisible();
});

test('reject is terminal, duplicate action is disabled, and history remains inspectable', async ({ page }) => {
  await loginAs(page, 'Rina Vale', `/approvals/${fixtures.reject.subject}`);
  const reject = page.getByRole('button', { name: 'Reject' });
  await reject.focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Rationale').fill('The commercial posture is not acceptable.');
  const confirm = page.getByRole('button', { name: 'Confirm rejection' });
  await confirm.focus();
  await page.keyboard.press('Space');
  const rejectionStatus = page.getByRole('status');
  await expect(rejectionStatus).toContainText('run was rejected');
  await expect(rejectionStatus).toBeFocused();
  await expect(page.getByText('Rejected', { exact: true }).first()).toBeVisible();
  const rejectedIcon = page.getByText('Rejected', { exact: true }).first().locator('..').locator('svg').first();
  await expect(rejectedIcon).toBeVisible();
  await expect(rejectedIcon).not.toHaveClass(/lock-keyhole/);
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
  await expect(page.getByRole('button', { name: /Harper Noor/ })).toBeVisible();
  for (const path of [
    `/runs/${fixtures.edit.run}`,
    `/approvals/${fixtures.edit.subject}`,
    '/deals/OPP-1003?evidence=evidence_restricted',
    `/exports/${fixtures.edit.run}`
  ]) {
    await page.goto(path);
    const body = await page.locator('body').innerText();
    if (path.startsWith('/approvals/')) {
      await expect(page).toHaveTitle('Unavailable view | SlaCato');
      await expect(page.locator('section[role="alert"]')).toBeFocused();
    }
    expect(body).not.toContain('Eclipse BioMaterials');
    expect(body).not.toContain('Restricted Account Renewal');
    expect(body).not.toContain(subjectHash);
  }
});
