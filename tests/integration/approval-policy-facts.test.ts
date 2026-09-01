import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DealBrief, dealBriefSchema } from '@slacato/core';
import { createDatabaseClient } from '@slacato/infrastructure/db/client';
import { PostgresDealBriefPolicyFacts } from '@slacato/infrastructure/db/repositories/deal-brief-access';

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
const databaseName = `catohw_policyfacts_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
const databaseNamePattern = /^catohw_policyfacts_[a-z0-9]{16}$/;

function databaseUrlFor(name: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const databaseUrl = databaseUrlFor(databaseName);
const database = createDatabaseClient(databaseUrl, 4);
const facts = new PostgresDealBriefPolicyFacts(database);

/** Builds a brief that trips no structured policy fact, varying only its generated prose. */
function brief(
  input: Readonly<{
    missingInformation: DealBrief['missingInformation']['items'];
    warnings: DealBrief['confidenceAndReviewWarnings']['warnings'];
  }>
): DealBrief {
  return dealBriefSchema.parse({
    dealSnapshot: {
      accountName: 'Policy Facts',
      opportunityName: 'Policy Facts Opportunity',
      stage: 'Negotiate'
    },
    executiveSummary: { narrative: 'The renewal is progressing on approved commercial terms.' },
    buyerGoalsAndBusinessDrivers: { goals: [], businessDrivers: [] },
    stakeholderMap: { stakeholders: [] },
    negotiationState: { currentState: 'The commercial position is settled.', risks: [] },
    recommendedNextActions: { actions: [] },
    missingInformation: { items: input.missingInformation },
    sourceEvidence: { evidence: [] },
    confidenceAndReviewWarnings: { overallConfidence: 0.95, warnings: input.warnings }
  });
}

async function createTemporaryDatabase(): Promise<void> {
  if (!databaseNamePattern.test(databaseName))
    throw new Error(`Refusing to create non-test database ${databaseName}`);
  const maintenance = postgres(databaseUrlFor('postgres'), { max: 1 });
  try {
    await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end({ timeout: 1 });
  }
  const migrationFiles = (await readdir(resolve(process.cwd(), 'drizzle')))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  const target = postgres(databaseUrl, { max: 1 });
  try {
    for (const file of migrationFiles)
      await target.unsafe(await readFile(resolve(process.cwd(), 'drizzle', file), 'utf8'));
  } finally {
    await target.end({ timeout: 1 });
  }
}

async function dropTemporaryDatabase(): Promise<void> {
  if (!databaseNamePattern.test(databaseName))
    throw new Error(`Refusing to drop non-test database ${databaseName}`);
  const maintenance = postgres(databaseUrlFor('postgres'), { max: 1 });
  try {
    await maintenance`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName} and pid <> pg_backend_pid()`;
    await maintenance.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await maintenance.end({ timeout: 1 });
  }
}

/** Seeds one opportunity whose structured policy facts require no approval at all. */
async function seedUntriggeredOpportunity(
  overrides: Readonly<{ missingMaterialEvidence?: boolean }> = {}
): Promise<string> {
  const id = crypto.randomUUID().replaceAll('-', '');
  const accountId = `account_policy_${id}`;
  const opportunityId = `opportunity_policy_${id}`;
  await database.sql`insert into accounts (id, name) values (${accountId}, 'Policy Facts Account')`;
  await database.sql`insert into opportunities (id, account_id, name) values (${opportunityId}, ${accountId}, 'Policy Facts Opportunity')`;
  await database.sql`insert into opportunity_policy_facts
    (opportunity_id, discount_percent, renewal_uplift_percent, missing_material_evidence, source_commit)
    values (${opportunityId}, 4, 8, ${overrides.missingMaterialEvidence ?? false}, ${'b'.repeat(40)})`;
  return opportunityId;
}

beforeAll(async () => {
  await createTemporaryDatabase();
}, 120_000);

afterAll(async () => {
  await database.close();
  await dropTemporaryDatabase();
});

describe('deal brief policy facts', () => {
  it('does not treat a populated missing-information section as missing material evidence', async () => {
    const opportunityId = await seedUntriggeredOpportunity();
    const resolved = await facts.forBrief(
      opportunityId,
      brief({
        missingInformation: [
          {
            question: 'Confirm the final owner matrix with the named account owner.',
            whyItMatters: 'The deal team cannot close the packet without it.'
          }
        ],
        warnings: [
          {
            code: 'INSUFFICIENT_CLAIM_SUPPORT',
            severity: 'warning',
            message: 'No single cited evidence unit supports the complete material relation.',
            claimIds: []
          }
        ]
      })
    );
    expect(resolved.missingMaterialEvidence).toBe(false);
  });

  it('reports missing material evidence when the brief raises that warning explicitly', async () => {
    const opportunityId = await seedUntriggeredOpportunity();
    const resolved = await facts.forBrief(
      opportunityId,
      brief({
        missingInformation: [],
        warnings: [
          {
            code: 'MISSING_MATERIAL_EVIDENCE',
            severity: 'critical',
            message: 'Authorized sources omit a material term of the renewal.',
            claimIds: []
          }
        ]
      })
    );
    expect(resolved.missingMaterialEvidence).toBe(true);
  });

  it('reports missing material evidence recorded as a structured opportunity fact', async () => {
    const opportunityId = await seedUntriggeredOpportunity({ missingMaterialEvidence: true });
    const resolved = await facts.forBrief(
      opportunityId,
      brief({ missingInformation: [], warnings: [] })
    );
    expect(resolved.missingMaterialEvidence).toBe(true);
  });
});
