import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The eight canonical demo personas and, for the six with general deal access, exactly which
 * opportunities they may read. Verified directly against a running API instance (see the task
 * notes) rather than assumed from the fixture TSVs, because the TSVs alone do not cover the two
 * approval-only identities (USR-5006, USR-5008), who have zero rows in
 * fixtures/cato/policies/access_permissions.tsv and get their access from
 * `DEMO_APPROVAL_IDENTITIES` in packages/core/src/domain/briefs/policy.ts instead.
 *
 * `deals` lists opportunities that MUST be readable. It intentionally does not assert an exact
 * list length or an exact absence set beyond the three canonical opportunities: local and CI runs
 * accumulate long-lived fixture rows under ACC-2003 from other e2e specs (approval.spec.ts does
 * not clean up between runs), so Nora Chen's and Rina Vale's real deal lists grow over time.
 * Asserting `toContain` for allowed ids and `not.toContain` for the other two canonical ids is
 * flake-proof against that debris; asserting array length is not.
 */
export const PERSONAS = Object.freeze({
  maya: Object.freeze({ id: 'USR-5001', name: 'Maya Levin', role: 'Account Owner', deals: ['OPP-1001'] as const }),
  owen: Object.freeze({ id: 'USR-5002', name: 'Owen Patel', role: 'Account Owner', deals: ['OPP-1002'] as const }),
  nora: Object.freeze({ id: 'USR-5003', name: 'Nora Chen', role: 'Restricted Account Owner', deals: ['OPP-1003'] as const }),
  sam: Object.freeze({ id: 'USR-5004', name: 'Sam Hale', role: 'Sales Leader', deals: ['OPP-1001', 'OPP-1002'] as const }),
  rina: Object.freeze({ id: 'USR-5005', name: 'Rina Vale', role: 'Deal Desk Approver', deals: ['OPP-1001', 'OPP-1002', 'OPP-1003'] as const }),
  iris: Object.freeze({ id: 'USR-5006', name: 'Iris Wynn', role: 'Legal Reviewer', deals: [] as const }),
  harper: Object.freeze({ id: 'USR-5007', name: 'Harper Noor', role: 'Unauthorized Requester', deals: ['OPP-1001'] as const }),
  tomas: Object.freeze({ id: 'USR-5008', name: 'Tomas Reed', role: 'Restricted Sales Leader', deals: [] as const })
});

export type PersonaKey = keyof typeof PERSONAS;

export const ALL_OPPORTUNITIES = ['OPP-1001', 'OPP-1002', 'OPP-1003'] as const;

/** Every opportunity the persona may NOT read, derived from `PERSONAS[key].deals`. */
export function deniedOpportunities(key: PersonaKey): readonly string[] {
  const allowed = new Set<string>(PERSONAS[key].deals);
  return ALL_OPPORTUNITIES.filter((id) => !allowed.has(id));
}

/**
 * Signs in through the real login UI, the same helper shape used by the other e2e specs. Four of
 * the eight personas (Owen Patel, Sam Hale, and any other non-scenario/non-authority identity)
 * render inside a collapsed native <details> disclosure ("Other fixture identities"); this opens
 * it first when the target button is not already visible, matching run-resume.spec.ts's pattern.
 */
export async function loginAs(page: Page, name: string, returnTo = '/deals'): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  const button = page.getByRole('button', { name: new RegExp(`Continue as ${name}`) });
  if (!(await button.isVisible())) {
    await page.getByText('Other fixture identities', { exact: true }).click();
  }
  await button.click();
  await expect(page).toHaveURL(returnTo);
}

/**
 * Selects a persona through the API directly (no browser page needed), for specs that only need
 * an authenticated `request` context. The API's origin/CSRF middleware rejects mutating AND plain
 * GET requests that lack a matching `Origin`/`Sec-Fetch-Site` pair -- every call through the
 * returned context must keep sending `apiHeaders()`, not just the login POST.
 */
export function apiHeaders(): Readonly<Record<string, string>> {
  return { Origin: 'http://127.0.0.1:4173', 'Sec-Fetch-Site': 'same-site' };
}

export async function selectPersonaViaApi(request: APIRequestContext, userId: string): Promise<void> {
  const headers = apiHeaders();
  const csrf = await request.get('/api/auth/csrf', { headers });
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const selected = await request.post('/api/auth/persona', {
    headers: { ...headers, 'X-CSRF-Token': csrfToken },
    data: { userId }
  });
  expect(selected.ok()).toBe(true);
}

/**
 * Strings that must never appear anywhere an unauthorized persona can read: the restricted
 * opportunity's identity, account, evidence sources, or the substance of its policy triggers.
 * Mirrors the list in no-leak-ui.spec.ts (kept independent rather than imported, per the
 * instruction not to modify or take a hard dependency on existing spec files).
 */
export const RESTRICTED_DEAL_TOKENS = [
  'OPP-1003',
  'Eclipse BioMaterials',
  'restricted-eclipse',
  'SLK-9007',
  'SLK-9008',
  'SLK-9009',
  'pricing_notes.tsv',
  'account_team_updates.tsv#SLK-9007',
  'account_team_updates.tsv#SLK-9008',
  'account_team_updates.tsv#SLK-9009',
  'aggressive discounting',
  'risk mitigation'
] as const;

export function expectOpaque(content: string): void {
  const lower = content.toLowerCase();
  for (const token of RESTRICTED_DEAL_TOKENS) expect(lower).not.toContain(token.toLowerCase());
}
