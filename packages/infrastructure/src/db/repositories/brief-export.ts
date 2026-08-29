import {
  CANONICAL_FIXTURE_COMMIT,
  collectDealBriefReferences,
  dealBriefSchema,
  exportBrief,
  type DealBriefExportFormat
} from '@slacato/core';
import type { DatabaseClient } from '../client.js';

type ManifestEntryRow = Readonly<{ citation_id: string; evidence_version_id: string; source_locator: string }>;
type FinalizedBriefRow = Readonly<{
  payload: unknown | null;
  opportunity_id: string | null;
  manifest_entries: readonly ManifestEntryRow[];
  readable_evidence_ids: readonly string[];
}>;

/** Exports immutable completed briefs only when every referenced evidence record remains readable. */
export class PostgresBriefExportService {
  /** Binds finalized brief export operations to the PostgreSQL database client. */
  public constructor(private readonly database: DatabaseClient) {}

  /** Produces the requested finalized brief and records an opaque denial or successful export atomically. */
  public async exportFinalized(input: Readonly<{
    actorId: string;
    runId: string;
    format: DealBriefExportFormat;
  }>): Promise<Readonly<{ content: string; format: DealBriefExportFormat }> | undefined> {
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
        ),
        citation_refs as materialized (
          select distinct citation.value ->> 'id' citation_id,
            citation.value ->> 'evidenceId' evidence_version_id,
            citation.value ->> 'locator' source_locator
          from candidate
          cross join lateral jsonb_path_query(candidate.payload, '$.**.citations[*]') as citation(value)
        ),
        evidence_refs as materialized (
          select citation.evidence_version_id evidence_id from citation_refs citation
          union
          select source.value ->> 'evidenceId'
          from candidate
          cross join lateral jsonb_array_elements(
            coalesce(candidate.payload #> '{sourceEvidence,evidence}', '[]'::jsonb)
          ) as source(value)
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
            join citation_refs citation on citation.citation_id = entry.citation_id
            where manifest.run_id = candidate.run_id
          ), '[]'::jsonb) manifest_entries,
          coalesce((
            select array_agg(evidence.id order by evidence.id)
            from evidence_refs reference
            join evidence_versions evidence on evidence.id = reference.evidence_id
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

      const brief = dealBriefSchema.parse(row.payload);
      const references = collectDealBriefReferences(brief);
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
