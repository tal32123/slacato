import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { buildEvidenceDocuments, CANONICAL_FIXTURE_COMMIT, chunkDocument, parseFixtureSet } from '../packages/core/src/index.js';

const DEFAULT_DATABASE_URL = 'postgres://slacato:slacato@127.0.0.1:54329/slacato';
type InsertCounts = Readonly<{ personas: number; grants: number; accounts: number; opportunities: number; contacts: number; documents: number; chunks: number }>;
export type IngestionResult = Readonly<{ inserted: InsertCounts; totalDocuments: number; totalChunks: number }>;
export type IngestionOptions = Readonly<{ root: string; databaseUrl: string }>;

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function permissionSources(sourceType: string): readonly string[] {
  if (sourceType === 'gong') return ['gong_summary', 'gong_transcript'];
  if (sourceType === 'policies') return ['policy'];
  return [sourceType];
}

/** Idempotently records normalized fixtures. Embedding concerns are intentionally absent from this boundary. */
export async function ingestFixtureRecords(options: IngestionOptions): Promise<IngestionResult> {
  const fixtures = parseFixtureSet(options.root);
  const documents = buildEvidenceDocuments(fixtures);
  const chunksByDocument = documents.map((document) => ({ document, chunks: chunkDocument(document) }));
  const sql = postgres(options.databaseUrl, { max: 2, idle_timeout: 5, connect_timeout: 5 });
  try {
    return await sql.begin(async (transaction) => {
      const counts = { personas: 0, grants: 0, accounts: 0, opportunities: 0, contacts: 0, documents: 0, chunks: 0 };
      for (const account of fixtures.accounts) {
        const inserted = await transaction`insert into accounts (id, name) values (${account.accountId}, ${account.accountName})
          on conflict (id) do update set name = excluded.name where accounts.name is distinct from excluded.name returning id`;
        counts.accounts += inserted.length;
      }
      for (const opportunity of fixtures.opportunities) {
        const inserted = await transaction`insert into opportunities (id, account_id, name, restricted) values (${opportunity.opportunityId}, ${opportunity.accountId}, ${opportunity.opportunityName}, ${opportunity.restrictedAccess})
          on conflict (id) do update set account_id = excluded.account_id, name = excluded.name, restricted = excluded.restricted
          where (opportunities.account_id, opportunities.name, opportunities.restricted) is distinct from (excluded.account_id, excluded.name, excluded.restricted) returning id`;
        counts.opportunities += inserted.length;
      }
      for (const contact of fixtures.contacts) {
        const inserted = await transaction`insert into contacts (id, account_id, name, email) values (${contact.contactId}, ${contact.accountId}, ${contact.fullName}, ${contact.email})
          on conflict (id) do update set account_id = excluded.account_id, name = excluded.name, email = excluded.email
          where (contacts.account_id, contacts.name, contacts.email) is distinct from (excluded.account_id, excluded.name, excluded.email) returning id`;
        counts.contacts += inserted.length;
      }
      for (const permission of fixtures.permissions) {
        const insertedPersona = await transaction`insert into personas (id, display_name, role, source_commit) values (${permission.userId}, ${permission.userName}, ${permission.role}, ${CANONICAL_FIXTURE_COMMIT})
          on conflict (id) do update set display_name = excluded.display_name, role = excluded.role, source_commit = excluded.source_commit
          where (personas.display_name, personas.role, personas.source_commit) is distinct from (excluded.display_name, excluded.role, excluded.source_commit) returning id`;
        counts.personas += insertedPersona.length;
        for (const accountId of permission.allowedAccountIds) for (const fixtureSource of permission.allowedSourceTypes) for (const sourceType of permissionSources(fixtureSource)) {
          const grantId = `grant:${permission.userId}:${accountId}:${sourceType}`;
          const insertedGrant = await transaction`insert into permission_grants (id, persona_id, account_id, source_type, can_read, can_read_restricted, can_approve, sensitive_pricing)
            values (${grantId}, ${permission.userId}, ${accountId}, ${sourceType}, true, ${permission.canViewRestrictedAccount}, ${permission.canRequestApproval}, ${permission.canViewSensitivePricing})
            on conflict (id) do update set persona_id = excluded.persona_id, account_id = excluded.account_id, source_type = excluded.source_type,
              can_read = excluded.can_read, can_read_restricted = excluded.can_read_restricted, can_approve = excluded.can_approve, sensitive_pricing = excluded.sensitive_pricing
            where (permission_grants.persona_id, permission_grants.account_id, permission_grants.source_type, permission_grants.can_read,
              permission_grants.can_read_restricted, permission_grants.can_approve, permission_grants.sensitive_pricing)
              is distinct from (excluded.persona_id, excluded.account_id, excluded.source_type, excluded.can_read,
                excluded.can_read_restricted, excluded.can_approve, excluded.sensitive_pricing) returning id`;
          counts.grants += insertedGrant.length;
        }
      }
      for (const { document, chunks } of chunksByDocument) {
        const documentId = `document:${document.sourceType}:${document.externalId}:v1`;
        const contentHash = sha256(document.content);
        const insertedDocument = await transaction`insert into document_versions
          (id, external_id, version, source_type, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
          values (${documentId}, ${document.externalId}, 1, ${document.sourceType}, ${contentHash}, ${document.content}, ${document.eventDate ?? null}, ${document.reliability}, ${document.sourceLocator}, ${document.classificationReason}, ${document.policyHash})
          on conflict (external_id, version) do nothing returning id`;
        counts.documents += insertedDocument.length;
        const persisted = await transaction<{ id: string; source_type: string; content_hash: string; event_date: string | null; reliability_class: string | null; source_locator: string | null; classification_reason: string | null; policy_hash: string | null }[]>`
          select id, source_type, content_hash, event_date::text, reliability_class, source_locator, classification_reason, policy_hash from document_versions where external_id = ${document.externalId} and version = 1`;
        const existing = persisted[0];
        if (existing === undefined || existing.id !== documentId || existing.source_type !== document.sourceType || existing.content_hash !== contentHash || existing.event_date !== (document.eventDate ?? null) || existing.reliability_class !== document.reliability || existing.source_locator !== document.sourceLocator || existing.classification_reason !== document.classificationReason || existing.policy_hash !== document.policyHash) {
          throw new Error(`Canonical document conflict requires a new immutable version: ${document.externalId}`);
        }
        for (const chunk of chunks) {
          const chunkHash = sha256(chunk.content);
          const insertedChunk = await transaction`insert into evidence_versions
            (id, document_version_id, account_id, opportunity_id, chunk_index, source_type, sensitivity, content_hash, content, event_date, reliability_class, source_locator, classification_reason, policy_hash)
            values (${chunk.id}, ${documentId}, ${chunk.accountId}, ${chunk.opportunityId ?? null}, ${chunk.chunkIndex}, ${chunk.sourceType}, ${chunk.accessLevel}, ${chunkHash}, ${chunk.content}, ${chunk.eventDate ?? null}, ${chunk.reliability}, ${chunk.sourceLocator}, ${chunk.classificationReason}, ${chunk.policyHash})
            on conflict (document_version_id, chunk_index) do nothing returning id`;
          counts.chunks += insertedChunk.length;
          const persistedChunk = await transaction<{ id: string; account_id: string; opportunity_id: string | null; source_type: string; sensitivity: string; content_hash: string; event_date: string | null; reliability_class: string | null; source_locator: string | null; classification_reason: string | null; policy_hash: string | null }[]>`
            select id, account_id, opportunity_id, source_type, sensitivity, content_hash, event_date::text, reliability_class, source_locator, classification_reason, policy_hash
            from evidence_versions where document_version_id = ${documentId} and chunk_index = ${chunk.chunkIndex}`;
          const existingChunk = persistedChunk[0];
          if (existingChunk === undefined || existingChunk.id !== chunk.id || existingChunk.account_id !== chunk.accountId || existingChunk.opportunity_id !== (chunk.opportunityId ?? null) || existingChunk.source_type !== chunk.sourceType || existingChunk.sensitivity !== chunk.accessLevel || existingChunk.content_hash !== chunkHash || existingChunk.event_date !== (chunk.eventDate ?? null) || existingChunk.reliability_class !== chunk.reliability || existingChunk.source_locator !== chunk.sourceLocator || existingChunk.classification_reason !== chunk.classificationReason || existingChunk.policy_hash !== chunk.policyHash) {
            throw new Error(`Canonical evidence conflict: ${chunk.id}`);
          }
        }
      }
      return { inserted: counts, totalDocuments: documents.length, totalChunks: chunksByDocument.reduce((total, entry) => total + entry.chunks.length, 0) };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const result = await ingestFixtureRecords({
    root: resolve(process.cwd(), 'fixtures/cato'),
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
