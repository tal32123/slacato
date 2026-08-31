import { expect, test } from '@playwright/test';
import type { Sql } from 'postgres';
import { connect, seedTriAuthorityApproval } from './support/approvals';
import {
  ALL_OPPORTUNITIES,
  apiHeaders,
  deniedOpportunities,
  expectOpaque,
  loginAs,
  PERSONAS,
  selectPersonaViaApi,
  type PersonaKey
} from './support/personas';

const OPAQUE_DENIAL_BODY = { code: 'FORBIDDEN', message: 'Request could not be authorized' };

test.describe('deal-visibility matrix, verified per persona against a running API', () => {
  for (const key of Object.keys(PERSONAS) as PersonaKey[]) {
    const persona = PERSONAS[key];

    test(`${persona.name} (${persona.role}) sees exactly her/his authorized deals and is opaquely denied the rest`, async ({
      request
    }) => {
      await selectPersonaViaApi(request, persona.id);
      const headers = apiHeaders();

      const list = await request.get('/api/deals', { headers });
      expect(list.status()).toBe(200);
      const body = (await list.json()) as { deals: readonly { opportunityId: string }[] };
      const listedIds = body.deals.map((deal) => deal.opportunityId);
      for (const allowed of persona.deals) expect(listedIds).toContain(allowed);
      for (const denied of deniedOpportunities(key)) expect(listedIds).not.toContain(denied);

      for (const allowed of persona.deals) {
        const detail = await request.get(`/api/deals/${allowed}`, { headers });
        expect(detail.status()).toBe(200);
      }
      for (const denied of deniedOpportunities(key)) {
        const detail = await request.get(`/api/deals/${denied}`, { headers });
        expect(detail.status()).toBe(403);
        expect(await detail.json()).toEqual(OPAQUE_DENIAL_BODY);
      }
    });
  }

  test('the two approval-only identities (Legal Reviewer, Restricted Sales Leader) have zero general deal access', async ({
    request
  }) => {
    for (const key of ['iris', 'tomas'] as const) {
      await selectPersonaViaApi(request, PERSONAS[key].id);
      const headers = apiHeaders();
      const list = await request.get('/api/deals', { headers });
      expect(await list.json()).toMatchObject({ deals: [] });
      for (const opportunityId of ALL_OPPORTUNITIES) {
        const detail = await request.get(`/api/deals/${opportunityId}`, { headers });
        expect(detail.status()).toBe(403);
      }
    }
  });
});

test.describe('unauthorized direct-URL access to the restricted deal never leaks its identity', () => {
  // Every persona except Nora Chen (owner) and Rina Vale (Deal Desk, authorized on all accounts)
  // must see a fully generic denial page when deep-linking straight to OPP-1003 -- not a 404, not
  // a variant message, and no page text that hints the record exists (name, account, discount).
  for (const key of ['maya', 'owen', 'sam', 'harper', 'iris', 'tomas'] as const) {
    const persona = PERSONAS[key];
    test(`${persona.name} deep-linking to /deals/OPP-1003 gets the same opaque "workspace not available" page`, async ({
      page
    }) => {
      await loginAs(page, persona.name, '/deals');
      await page.goto('/deals/OPP-1003');
      await expect(page).toHaveURL('/forbidden');
      await expect(page.getByRole('heading', { name: 'This workspace is not available' })).toBeVisible();
      const body = await page.locator('body').innerText();
      expectOpaque(body);
    });
  }
});

test.describe('approval authority resolution is scoped by account, not by role name alone', () => {
  let sql: Sql;
  test.beforeAll(() => {
    sql = connect();
  });
  test.afterAll(async () => {
    await sql.end({ timeout: 1 });
  });

  test('each approver sees only the entry matching their own authority and account grant', async ({ request }) => {
    const fixture = await seedTriAuthorityApproval(sql);

    async function pendingEntryIds(userId: string): Promise<readonly string[]> {
      await selectPersonaViaApi(request, userId);
      const headers = apiHeaders();
      const response = await request.get('/api/approvals', { headers });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { pending: readonly { entryId: string; opportunityId: string }[] };
      return body.pending
        .filter((entry) => entry.opportunityId === fixture.opportunityId)
        .map((entry) => entry.entryId);
    }

    expect(await pendingEntryIds(PERSONAS.rina.id)).toEqual([fixture.dealDeskEntryId]);
    expect(await pendingEntryIds(PERSONAS.iris.id)).toEqual([fixture.legalEntryId]);
    expect(await pendingEntryIds(PERSONAS.tomas.id)).toEqual([fixture.salesLeaderEntryId]);

    // Sam Hale holds the same 'sales_leader' authority as Tomas Reed, but his grant is scoped to
    // ACC-2001/ACC-2002 -- not ACC-2003, where this fixture's opportunity lives. If authority
    // resolution matched on role/authority name alone (ignoring the account grant), Sam would
    // wrongly see Tomas's entry here.
    expect(await pendingEntryIds(PERSONAS.sam.id)).toEqual([]);
    // Maya Levin and Harper Noor hold no approval authority at all.
    expect(await pendingEntryIds(PERSONAS.maya.id)).toEqual([]);
    expect(await pendingEntryIds(PERSONAS.harper.id)).toEqual([]);
  });
});
