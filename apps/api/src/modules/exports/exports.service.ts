import { CANONICAL_FIXTURE_COMMIT, dealBriefSchema, exportBrief, type DealBriefExportFormat } from '@slacato/core';
import type { DatabaseClient } from '@slacato/infrastructure';

export const BRIEF_EXPORT_SERVICE = Symbol('BRIEF_EXPORT_SERVICE');

export type BriefExportResult = Readonly<{
  content: string;
  format: DealBriefExportFormat;
}>;

export interface BriefExportService {
  exportFinalized(input: Readonly<{
    actorId: string;
    runId: string;
    format: DealBriefExportFormat;
  }>): Promise<BriefExportResult | undefined>;
}

type ManifestEntryRow = Readonly<{ citation_id: string; evidence_version_id: string; source_locator: string }>;
type FinalizedBriefRow = Readonly<{
  payload: unknown | null;
  opportunity_id: string | null;
  manifest_entries: readonly ManifestEntryRow[];
  readable_evidence_ids: readonly string[];
}>;
type CitationProjection = Readonly<{ id: string; evidenceId: string; locator: string }>;
type BriefReferences = Readonly<{ evidenceIds: readonly string[]; citations: readonly CitationProjection[] }>;

function referencedEvidence(payload: unknown): BriefReferences {
  const brief = dealBriefSchema.parse(payload);
  const evidenceIds = new Set<string>(brief.sourceEvidence.evidence.map(({ evidenceId }) => evidenceId));
  const citations = new Map<string, CitationProjection>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string' && typeof record.evidenceId === 'string' && typeof record.locator === 'string') {
      evidenceIds.add(record.evidenceId);
      citations.set(`${record.id}\u0000${record.evidenceId}\u0000${record.locator}`, {
        id: record.id, evidenceId: record.evidenceId, locator: record.locator
      });
    }
    Object.values(record).forEach(visit);
  };
  visit(brief);
  return {
    evidenceIds: [...evidenceIds].sort(),
    citations: [...citations.values()].sort((left, right) =>
      left.id.localeCompare(right.id) || left.evidenceId.localeCompare(right.evidenceId) || left.locator.localeCompare(right.locator))
  };
}

/** Reads only immutable completed state and fails closed unless every exported evidence reference is currently readable. */
export class PostgresBriefExportService implements BriefExportService {
  public constructor(private readonly database: DatabaseClient) {}

  public async exportFinalized(input: Readonly<{ actorId: string; runId: string; format: DealBriefExportFormat }>): Promise<BriefExportResult | undefined> {
    return this.database.sql.begin(async (sql) => {
      const deny = async (): Promise<undefined> => {
        await sql`insert into audit_events (id, run_id, actor_id, type, payload)
          values (${`audit_${crypto.randomUUID()}`}, null, ${input.actorId}, 'brief_export_denied',
            '{\"reason\":\"not_found\"}'::jsonb)`;
        return undefined;
      };
      const row = (await sql<FinalizedBriefRow[]>`
        with candidate as materialized (
          select run.id run_id, brief.payload, opportunity.id opportunity_id
          from runs run
          join opportunities opportunity on opportunity.id = run.opportunity_id
          join accounts account on account.id = opportunity.account_id
          join briefs brief on brief.run_id = run.id
          where run.id = ${input.runId} and run.status = 'completed' and brief.finalized_at is not null
            and exists (
              select 1 from permission_grants permission
              where permission.persona_id = ${input.actorId} and permission.account_id = account.id
                and permission.can_read and permission.source_commit = ${CANONICAL_FIXTURE_COMMIT}
                and (not opportunity.restricted or permission.can_read_restricted)
            )
          order by brief.draft_version desc limit 1
        )
        select candidate.payload, candidate.opportunity_id,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'citation_id', entry.citation_id,
              'evidence_version_id', entry.evidence_version_id,
              'source_locator', entry.source_locator
            ) order by entry.citation_id)
            from run_evidence_manifest_entries entry
            join run_evidence_manifests manifest on manifest.id = entry.manifest_id
            where manifest.run_id = candidate.run_id
          ), '[]'::jsonb) manifest_entries,
          coalesce((
            select array_agg(evidence.id order by evidence.id)
            from evidence_versions evidence
            join opportunities opportunity on opportunity.id = evidence.opportunity_id
            where evidence.opportunity_id = candidate.opportunity_id
              and evidence.account_id = opportunity.account_id
              and evidence.source_locator is not null and btrim(evidence.source_locator) <> ''
              and exists (
                select 1 from permission_grants source_grant
                where source_grant.persona_id = ${input.actorId}
                  and source_grant.account_id = evidence.account_id
                  and source_grant.source_type = evidence.source_type
                  and source_grant.can_read = true
                  and source_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
                  and (opportunity.restricted = false or source_grant.can_read_restricted = true)
                  and (
                    evidence.sensitivity <> 'restricted'
                    or (evidence.source_type = 'pricing' and source_grant.sensitive_pricing = true)
                    or (evidence.source_type <> 'pricing' and source_grant.can_read_restricted = true)
                  )
              )
          ), array[]::text[]) readable_evidence_ids
        from (values (true)) singleton(always_one)
        left join candidate on true`)[0];
      if (row?.payload === null || row === undefined) return deny();

      const references = referencedEvidence(row.payload);
      const entriesByCitation = new Map<string, readonly ManifestEntryRow[]>();
      for (const entry of row.manifest_entries) {
        const entries = entriesByCitation.get(entry.citation_id) ?? [];
        entriesByCitation.set(entry.citation_id, [...entries, entry]);
      }
      if (references.citations.some((citation) => {
        const entries = entriesByCitation.get(citation.id);
        return entries?.length !== 1
          || entries[0]?.evidence_version_id !== citation.evidenceId
          || entries[0]?.source_locator !== citation.locator;
      })) return deny();

      const readableEvidenceIds = new Set(row.readable_evidence_ids);
      if (references.evidenceIds.some((evidenceId) => !readableEvidenceIds.has(evidenceId))) return deny();

      const content = exportBrief(row.payload, input.format);
      await sql`insert into audit_events (id, run_id, actor_id, type, payload)
        values (${`audit_${crypto.randomUUID()}`}, ${input.runId}, ${input.actorId}, 'brief_exported',
          ${JSON.stringify({ format: input.format, status: 'completed' })}::jsonb)`;
      return { content, format: input.format };
    });
  }
}
