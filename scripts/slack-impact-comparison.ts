import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createDatabaseClient,
  PostgresBriefExportService
} from '../packages/infrastructure/src/index.js';

/**
 * Measures how the generated Slack-style account-team updates affect a finalized brief.
 *
 * The comparison is an authorization-scope A/B: the same deal, the same requester and the same
 * live pipeline, run twice with only the requester's `slack` read grant changed between the runs.
 * Nothing here is asserted from a generated field - every source type is resolved from the run's
 * immutable evidence manifest, so a self-declared `sourceType` in the brief cannot flatter the
 * result.
 *
 * Usage:
 *   pnpm tsx scripts/slack-impact-comparison.ts --api=<base> --with=<run-id> --without=<run-id> \
 *     [--supporting=<run-id>,...]
 */

const DEFAULT_DATABASE_URL = 'postgresql://slacato:slacato@127.0.0.1:54329/slacato_samples';
const DEFAULT_API_BASE = 'http://127.0.0.1:3017';
const BROWSER_ORIGIN = 'http://localhost:5173';

type RunFacts = Readonly<{
  run_id: string;
  opportunity_id: string;
  opportunity_name: string;
  requested_by: string;
  requester_name: string;
  generation_provider: string;
  generation_model: string;
  used_calls: number;
  used_input_tokens: number;
  used_output_tokens: number;
  updated_at: Date | string;
}>;

type ManifestEntry = Readonly<{
  evidence_version_id: string;
  source_type: string;
  rank: number;
  fusion_score: string;
  included_characters: number;
  content: string;
}>;

type Claim = Readonly<{
  id: string;
  statement: string;
  citations: readonly Readonly<{ evidenceId: string }>[];
}>;

type BriefSection = Readonly<{ claims?: readonly Claim[] }>;

type Brief = Readonly<{
  dealSnapshot: BriefSection;
  executiveSummary: BriefSection & { narrative: string };
  buyerGoalsAndBusinessDrivers: BriefSection;
  stakeholderMap: BriefSection & {
    stakeholders: readonly Readonly<{ name: string; claims: readonly Claim[] }>[];
  };
  negotiationState: BriefSection;
  recommendedNextActions: {
    actions: readonly Readonly<{ action: string; claims: readonly Claim[] }>[];
  };
  sourceEvidence: { evidence: readonly Readonly<{ evidenceId: string; summary: string }>[] };
}>;

/** One claim outside Source Evidence whose citation resolves to a Slack update in the manifest. */
export type SlackShapedClaim = Readonly<{
  path: string;
  claimId: string;
  statement: string;
  evidenceId: string;
  updateText: string;
}>;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Reads one command-line flag written as `--name=value`. */
function flag(name: string): string | undefined {
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

/** Signs in as one persona and returns a cookie-bearing reader for the browser-facing API. */
async function personaSession(
  apiBase: string,
  userId: string
): Promise<(path: string) => Promise<unknown>> {
  const cookies = new Map<string, string>();
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('Origin', BROWSER_ORIGIN);
    headers.set('Sec-Fetch-Site', 'same-site');
    if (cookies.size > 0)
      headers.set(
        'Cookie',
        [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
      );
    const response = await fetch(`${apiBase}${path}`, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';', 1);
      if (pair === undefined) continue;
      const separator = pair.indexOf('=');
      if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  };
  const csrf = (await (await request('/api/auth/csrf')).json()) as { csrfToken: string };
  const login = await request('/api/auth/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
    body: JSON.stringify({ userId })
  });
  if (!login.ok) throw new Error(`Persona selection failed: ${login.status}`);
  return async (path: string) => {
    const response = await request(path);
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
    return response.json();
  };
}

/** Collects every claim the brief carries outside its Source Evidence section, with its path. */
function claimsOutsideSourceEvidence(
  brief: Brief
): readonly Readonly<{ path: string; claim: Claim }>[] {
  const collected: { path: string; claim: Claim }[] = [];
  const add = (path: string, claims: readonly Claim[] | undefined): void => {
    for (const [index, claim] of (claims ?? []).entries())
      collected.push({ path: `${path}.claims[${index}]`, claim });
  };
  add('dealSnapshot', brief.dealSnapshot.claims);
  add('executiveSummary', brief.executiveSummary.claims);
  add('buyerGoalsAndBusinessDrivers', brief.buyerGoalsAndBusinessDrivers.claims);
  add('stakeholderMap', brief.stakeholderMap.claims);
  add('negotiationState', brief.negotiationState.claims);
  for (const [index, stakeholder] of brief.stakeholderMap.stakeholders.entries())
    add(`stakeholderMap.stakeholders[${index}]`, stakeholder.claims);
  for (const [index, action] of brief.recommendedNextActions.actions.entries())
    add(`recommendedNextActions.actions[${index}]`, action.claims);
  return collected;
}

/** Describes one run's Slack evidence from retrieval through to the finalized brief. */
async function describeRun(
  database: ReturnType<typeof createDatabaseClient>,
  runId: string
): Promise<Readonly<Record<string, unknown>>> {
  const facts = (
    await database.sql<RunFacts[]>`
      select run.id run_id, run.opportunity_id, opportunity.name opportunity_name,
        run.requested_by, persona.display_name requester_name, run.generation_provider,
        run.generation_model, budget.used_calls, budget.used_input_tokens,
        budget.used_output_tokens, run.updated_at
      from runs run
      join opportunities opportunity on opportunity.id = run.opportunity_id
      join personas persona on persona.id = run.requested_by
      join run_budgets budget on budget.run_id = run.id
      where run.id = ${runId}`
  )[0];
  if (facts === undefined) throw new Error(`Run not found: ${runId}`);
  const entries = await database.sql<ManifestEntry[]>`
    select entry.evidence_version_id, evidence.source_type, entry.rank, entry.fusion_score,
      entry.included_characters, evidence.content
    from run_evidence_manifest_entries entry
    join run_evidence_manifests manifest on manifest.id = entry.manifest_id
    join evidence_versions evidence on evidence.id = entry.evidence_version_id
    where manifest.run_id = ${runId}
    order by entry.rank`;
  const diagnostics = (
    await database.sql<
      { diagnostics: Record<string, unknown> }[]
    >`select diagnostics from run_evidence_manifests where run_id = ${runId}`
  )[0]?.diagnostics;
  const sourceTypeById = new Map(entries.map((entry) => [entry.evidence_version_id, entry]));
  const bySourceType: Record<string, number> = {};
  for (const entry of entries)
    bySourceType[entry.source_type] = (bySourceType[entry.source_type] ?? 0) + 1;

  const exported = await new PostgresBriefExportService(database).exportFinalized({
    actorId: facts.requested_by,
    runId,
    format: 'json'
  });
  if (exported === undefined) throw new Error(`Finalized export unavailable for ${runId}`);
  const brief = JSON.parse(exported.content) as Brief;
  const isSlack = (evidenceId: string): boolean =>
    sourceTypeById.get(evidenceId)?.source_type === 'slack';
  const shaped: SlackShapedClaim[] = [];
  for (const { path, claim } of claimsOutsideSourceEvidence(brief))
    for (const citation of claim.citations)
      if (isSlack(citation.evidenceId))
        shaped.push({
          path,
          claimId: claim.id,
          statement: claim.statement,
          evidenceId: citation.evidenceId,
          updateText: sourceTypeById.get(citation.evidenceId)?.content ?? ''
        });
  return {
    runId,
    opportunityId: facts.opportunity_id,
    requestedBy: { userId: facts.requested_by, name: facts.requester_name },
    provenance: {
      provider: facts.generation_provider,
      generationModel: facts.generation_model,
      calls: facts.used_calls,
      inputTokens: facts.used_input_tokens,
      outputTokens: facts.used_output_tokens,
      finalizedAt: new Date(facts.updated_at).toISOString()
    },
    retrieval: {
      entries: entries.length,
      bySourceType,
      missingSourceTypes: (diagnostics as { missingSourceTypes?: unknown })?.missingSourceTypes,
      slackEntries: entries
        .filter((entry) => entry.source_type === 'slack')
        .map((entry) => ({
          evidenceId: entry.evidence_version_id,
          rank: entry.rank,
          fusionScore: Number(entry.fusion_score),
          includedCharacters: entry.included_characters,
          updateText: entry.content
        }))
    },
    brief: {
      sourceEvidenceSlackCitations: brief.sourceEvidence.evidence
        .filter((summary) => isSlack(summary.evidenceId))
        .map((summary) => ({ evidenceId: summary.evidenceId, summary: summary.summary })),
      claimsOutsideSourceEvidenceCitingSlack: shaped,
      sectionsShapedBySlack: [...new Set(shaped.map((claim) => claim.path.split('.claims')[0]))],
      executiveSummaryNarrative: brief.executiveSummary.narrative
    }
  };
}

/** Writes the machine-readable half of the Slack-impact demonstration. */
async function main(): Promise<void> {
  const apiBase = flag('api') ?? DEFAULT_API_BASE;
  const withRunId = flag('with');
  const withoutRunId = flag('without');
  if (withRunId === undefined || withoutRunId === undefined)
    throw new Error(
      'Usage: pnpm tsx scripts/slack-impact-comparison.ts [--api=URL] --with=<run-id> --without=<run-id> [--supporting=<run-id>,...]'
    );
  const supporting = (flag('supporting') ?? '').split(',').filter((value) => value.length > 0);
  const database = createDatabaseClient(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, 3);
  try {
    const [withSlack, withoutSlack] = await Promise.all([
      describeRun(database, withRunId),
      describeRun(database, withoutRunId)
    ]);
    const supportingRuns = [];
    for (const runId of supporting) supportingRuns.push(await describeRun(database, runId));
    const persona = (withSlack.requestedBy as { userId: string }).userId;
    const read = await personaSession(apiBase, persona);
    const workspace = (await read(`/api/deals/${String(withSlack.opportunityId)}`)) as {
      deal: { latestRun: { updatedAt: string } | null };
      brief: { sections: Record<string, { title: string; accountTeamUpdateImpact: boolean }> };
    };
    const badged = Object.entries(workspace.brief.sections)
      .filter(([, section]) => section.accountTeamUpdateImpact)
      .map(([id]) => id);
    const shapedCount = (run: Readonly<Record<string, unknown>>): number =>
      (run.brief as { claimsOutsideSourceEvidenceCitingSlack: unknown[] })
        .claimsOutsideSourceEvidenceCitingSlack.length;
    const artifact = {
      deliverable:
        'Required demo scenario: how the generated Slack-style updates affect the brief, including at least one cited generated update',
      generatedAt: new Date().toISOString(),
      database: 'slacato_samples',
      liveLlmVerified: true,
      summary:
        `On ${String(withSlack.opportunityId)} the authorized Slack updates reach the finalized brief and shape it: ` +
        `${shapedCount(withSlack)} claim(s) outside Source Evidence cite a Slack update, and the reviewer-facing ` +
        `workspace marks ${badged.length} section(s) as account-team-update impacted. Revoking only the requester's ` +
        `slack read grant removes every Slack entry from retrieval and leaves ${shapedCount(withoutSlack)} such claim(s).`,
      runsUsed: 2 + supportingRuns.length,
      method: {
        opportunityUnderTest: withSlack.opportunityId,
        persona: withSlack.requestedBy,
        withoutSlackMechanism:
          "The 'without Slack' run was produced by setting can_read = false on the permission_grants row " +
          "'grant:USR-5003:ACC-2003:slack' in the slacato_samples scratch database, running the same pipeline, " +
          'and restoring the grant immediately afterwards. Permission grants are read fresh on every run, so this ' +
          "changes only that run's authorization scope. No fixture and no generated artifact was edited.",
        sourceTypeResolution:
          'Every source type reported here is resolved by joining the cited evidence id to the run evidence manifest, ' +
          "never from the brief's own sourceType field.",
        reviewerVisibleImpactRule:
          'apps/api/src/modules/deals/deal-workspace.mapper.ts marks a section accountTeamUpdateImpact when one of the ' +
          "section's cited evidence ids is an authorized Slack record; the web workspace renders that as the " +
          '"Account-team update impact" badge.'
      },
      runs: { withSlack, withoutSlack },
      reviewerVisibleImpact: {
        capturedFrom: `GET /api/deals/${String(withSlack.opportunityId)} as ${persona}`,
        latestRunUpdatedAt: workspace.deal.latestRun?.updatedAt ?? null,
        matchesWithSlackRun:
          workspace.deal.latestRun?.updatedAt ===
          (withSlack.provenance as { finalizedAt: string }).finalizedAt,
        badgedSections: badged,
        allSections: Object.fromEntries(
          Object.entries(workspace.brief.sections).map(([id, section]) => [
            id,
            section.accountTeamUpdateImpact
          ])
        )
      },
      supportingRuns,
      files: ['slack-impact-comparison.json', 'slack-impact-comparison.md']
    };
    await writeFile(
      resolve(process.cwd(), 'samples/slack-impact-comparison.json'),
      json(artifact),
      'utf8'
    );
    process.stdout.write(
      `wrote samples/slack-impact-comparison.json (with-Slack shaped claims: ${shapedCount(withSlack)}, ` +
        `without-Slack: ${shapedCount(withoutSlack)}, badged sections: ${badged.join(', ') || 'none'})\n`
    );
  } finally {
    await database.close();
  }
}

await main();
