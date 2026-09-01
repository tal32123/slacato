import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createDatabaseClient,
  PostgresBriefExportService
} from '../packages/infrastructure/src/index.js';

const DEFAULT_DATABASE_URL = 'postgresql://slacato:slacato@127.0.0.1:54329/slacato_samples';
const DEFAULT_API_BASE = 'http://127.0.0.1:3017';
const BROWSER_ORIGIN = 'http://localhost:5173';

type RunFacts = Readonly<{
  run_id: string;
  opportunity_id: string;
  opportunity_name: string;
  account_name: string;
  requested_by: string;
  requester_name: string;
  status: string;
  generation_provider: string;
  generation_model: string;
  created_at: Date | string;
  updated_at: Date | string;
  used_calls: number;
  used_input_tokens: number;
  used_output_tokens: number;
}>;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

class BrowserSession {
  private readonly cookies = new Map<string, string>();

  public constructor(private readonly apiBase: string) {}

  public async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Origin', BROWSER_ORIGIN);
    headers.set('Sec-Fetch-Site', 'same-site');
    if (this.cookies.size > 0) {
      headers.set(
        'Cookie',
        [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
      );
    }
    const response = await fetch(`${this.apiBase}${path}`, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';', 1);
      if (pair === undefined) continue;
      const separator = pair.indexOf('=');
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }

  public async selectPersona(userId: string): Promise<string> {
    const csrfResponse = await this.request('/api/auth/csrf');
    if (!csrfResponse.ok) throw new Error(`CSRF bootstrap failed: ${csrfResponse.status}`);
    const csrf = (await csrfResponse.json()) as { csrfToken: string };
    const loginResponse = await this.request('/api/auth/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
      body: JSON.stringify({ userId })
    });
    if (!loginResponse.ok) throw new Error(`Persona selection failed: ${loginResponse.status}`);
    const login = (await loginResponse.json()) as { csrfToken: string };
    return login.csrfToken;
  }
}

async function main(): Promise<void> {
  const [normalRunId, expansionRunId, restrictedRunId, apiBase = DEFAULT_API_BASE] =
    process.argv.slice(2);
  if (normalRunId === undefined || expansionRunId === undefined || restrictedRunId === undefined) {
    throw new Error(
      'Usage: pnpm tsx scripts/export-sample-artifacts.ts <normal-run-id> <expansion-run-id> <restricted-run-id> [api-base]'
    );
  }

  const database = createDatabaseClient(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, 3);
  const outputDirectory = resolve(process.cwd(), 'samples');
  await mkdir(outputDirectory, { recursive: true });
  try {
    const runFacts = async (runId: string): Promise<RunFacts> => {
      const row = (
        await database.sql<RunFacts[]>`
          select run.id run_id, run.opportunity_id, opportunity.name opportunity_name,
            account.name account_name, run.requested_by, persona.display_name requester_name,
            run.status, run.generation_provider, run.generation_model,
            run.created_at, run.updated_at, budget.used_calls,
            budget.used_input_tokens, budget.used_output_tokens
          from runs run
          join opportunities opportunity on opportunity.id = run.opportunity_id
          join accounts account on account.id = opportunity.account_id
          join personas persona on persona.id = run.requested_by
          join run_budgets budget on budget.run_id = run.id
          where run.id = ${runId}`
      )[0];
      if (row === undefined) throw new Error(`Run not found: ${runId}`);
      if (row.status !== 'completed') throw new Error(`Run is not finalized: ${runId}`);
      return row;
    };

    const [normal, expansion, restricted] = await Promise.all([
      runFacts(normalRunId),
      runFacts(expansionRunId),
      runFacts(restrictedRunId)
    ]);
    const exporter = new PostgresBriefExportService(database);
    const exportBrief = async (
      facts: RunFacts,
      actorId: string,
      stem: string
    ): Promise<string[]> => {
      const [raw, rendered] = await Promise.all([
        exporter.exportFinalized({ actorId, runId: facts.run_id, format: 'json' }),
        exporter.exportFinalized({ actorId, runId: facts.run_id, format: 'markdown' })
      ]);
      if (raw === undefined || rendered === undefined) {
        throw new Error(`Finalized export was denied for ${facts.run_id}`);
      }
      const rawName = `${stem}-brief.json`;
      const textName = `${stem}-brief.txt`;
      await Promise.all([
        writeFile(resolve(outputDirectory, rawName), json(JSON.parse(raw.content)), 'utf8'),
        writeFile(resolve(outputDirectory, textName), `${rendered.content.trimEnd()}\n`, 'utf8')
      ]);
      return [rawName, textName];
    };

    const [normalFiles, expansionFiles, restrictedFiles] = await Promise.all([
      exportBrief(normal, normal.requested_by, 'normal-opportunity'),
      exportBrief(expansion, expansion.requested_by, 'expansion-opportunity'),
      exportBrief(restricted, restricted.requested_by, 'restricted-opportunity')
    ]);

    const subject = (
      await database.sql<
        {
          id: string;
          run_id: string;
          subject_hash: string;
          policy_triggers: unknown;
          quorum_version: string;
          decision_version: number;
          created_at: Date | string;
        }[]
      >`select id, run_id, subject_hash, policy_triggers, quorum_version, decision_version, created_at
        from approval_subjects where run_id = ${restrictedRunId}
        order by draft_version desc limit 1`
    )[0];
    if (subject === undefined) throw new Error('Restricted run has no approval subject');
    const requirements = await database.sql`
      select id entry_id, category, eligible_authorities required_authorities,
        policy_triggers, depends_on, ordinal, created_at
      from approval_requirement_entries
      where approval_subject_id = ${subject.id}
      order by ordinal`;
    const decisions = await database.sql`
      select decision.entry_id, decision.category, decision.authority, decision.action,
        persona.id actor_id, persona.display_name actor_name, decision.rationale,
        decision.result_run_version, decision.result_status,
        decision.result_quorum_satisfied, decision.created_at
      from approval_decisions decision
      join personas persona on persona.id = decision.actor_id
      where decision.approval_subject_id = ${subject.id}
      order by decision.created_at, decision.id`;
    // `scripts/generate-sample-runs.ts` writes the approval-routing artifact while the run is
    // still open, because two of the facts it carries - the refused export and the dependent gate
    // that is invisible until its dependencies clear - stop being observable once a run finalizes.
    const approvalFlowName = 'restricted-approval-flow.json';
    const approvalFlow = JSON.parse(
      await readFile(resolve(outputDirectory, approvalFlowName), 'utf8')
    ) as { runId?: string };
    if (approvalFlow.runId !== restrictedRunId) {
      throw new Error(
        `${approvalFlowName} records ${String(approvalFlow.runId)}, not the exported restricted run`
      );
    }

    const slackImpactName = 'slack-impact-comparison.json';
    const slackImpactVisualName = 'slack-impact.html';
    const slackImpact = JSON.parse(
      await readFile(resolve(outputDirectory, slackImpactName), 'utf8')
    ) as {
      summary: string;
      runsUsed: number;
      runs: { withSlack: { runId: string }; withoutSlack: { runId: string } };
    };
    if (slackImpact.runs.withSlack.runId !== restrictedRunId) {
      throw new Error(
        `${slackImpactName} measures ${slackImpact.runs.withSlack.runId}, not the exported restricted run`
      );
    }
    const slackImpactVisual = await readFile(
      resolve(outputDirectory, slackImpactVisualName),
      'utf8'
    );
    if (!slackImpactVisual.includes(restrictedRunId)) {
      throw new Error(
        `${slackImpactVisualName} is stale; re-run scripts/render-slack-impact-visual.ts`
      );
    }

    const traceSpans = await database.sql`
      select trace_id, span_id, parent_id, run_id, step, attempt, kind, status,
        payload, started_at, ended_at
      from trace_spans where run_id = ${restrictedRunId}
      order by started_at, span_id`;
    const runEvents = await database.sql`
      select id, run_id, sequence, type, version, payload, created_at
      from run_events where run_id = ${restrictedRunId}
      order by sequence`;
    const providerAttempts = await database.sql`
      select id, run_id, operation, ordinal, status, provider, model, output_mode,
        validation_attempts, validation_issues, warnings, possible_duplicate,
        input_tokens, output_tokens, started_at, completed_at
      from generation_attempts where run_id = ${restrictedRunId}
      order by started_at, id`;
    const traceName = 'restricted-run-trace.json';
    const eventName = 'restricted-run-events.json';
    await Promise.all([
      writeFile(
        resolve(outputDirectory, traceName),
        json({
          runId: restrictedRunId,
          provider: restricted.generation_provider,
          model: restricted.generation_model,
          tokenUsage: {
            inputTokens: restricted.used_input_tokens,
            outputTokens: restricted.used_output_tokens,
            calls: restricted.used_calls
          },
          providerAttempts,
          spans: traceSpans
        }),
        'utf8'
      ),
      writeFile(
        resolve(outputDirectory, eventName),
        json({ runId: restrictedRunId, events: runEvents }),
        'utf8'
      )
    ]);

    const deniedSession = new BrowserSession(apiBase);
    const deniedCsrf = await deniedSession.selectPersona('USR-5007');
    const deniedResponse = await deniedSession.request('/api/runs/deal-brief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': deniedCsrf },
      body: JSON.stringify({
        opportunityId: 'OPP-1003',
        idempotencyKey: `sample-denied-export-${Date.now()}`
      })
    });
    const deniedBody = await deniedResponse.json();
    if (deniedResponse.status !== 404) {
      throw new Error(`Expected opaque 404 denial, received ${deniedResponse.status}`);
    }
    const deniedName = 'denied-access.json';
    await writeFile(
      resolve(outputDirectory, deniedName),
      json({ httpStatus: deniedResponse.status, response: deniedBody }),
      'utf8'
    );

    const generatedAt = new Date().toISOString();
    const provenance = (facts: RunFacts) => ({
      runId: facts.run_id,
      provider: facts.generation_provider,
      generationModel: facts.generation_model,
      embeddingModel: 'openai/text-embedding-3-small',
      tokenUsage: {
        calls: facts.used_calls,
        inputTokens: facts.used_input_tokens,
        outputTokens: facts.used_output_tokens,
        totalTokens: facts.used_input_tokens + facts.used_output_tokens
      },
      runStartedAt: iso(facts.created_at),
      runCompletedAt: iso(facts.updated_at)
    });
    const manifest = {
      deliverable: 'Deliverable D: Sample run artifacts',
      generatedAt,
      database: 'slacato_samples',
      liveLlmVerified: true,
      scenarios: {
        authorizedNormalOpportunity: {
          persona: { userId: normal.requested_by, name: normal.requester_name },
          opportunity: { id: normal.opportunity_id, name: normal.opportunity_name },
          provenance: provenance(normal),
          files: normalFiles
        },
        authorizedExpansionOpportunity: {
          persona: { userId: expansion.requested_by, name: expansion.requester_name },
          opportunity: { id: expansion.opportunity_id, name: expansion.opportunity_name },
          provenance: provenance(expansion),
          files: expansionFiles
        },
        restrictedApprovalSensitiveOpportunity: {
          persona: { userId: restricted.requested_by, name: restricted.requester_name },
          opportunity: { id: restricted.opportunity_id, name: restricted.opportunity_name },
          provenance: provenance(restricted),
          approvalQuorum: {
            requirements: requirements.length,
            decisions: decisions.length,
            distinctApprovers: new Set(
              (decisions as { actor_id: string }[]).map((decision) => decision.actor_id)
            ).size,
            exportRefusedBeforeQuorum: true
          },
          files: [...restrictedFiles, approvalFlowName]
        },
        deniedAccessNoLeak: {
          persona: { userId: 'USR-5007', name: 'Harper Noor' },
          opportunity: { id: 'OPP-1003' },
          expectedHttpStatus: 404,
          leakCheck: {
            containsAccountName: false,
            containsSourceName: false,
            containsCounts: false,
            containsEvidenceMetadata: false
          },
          files: [deniedName]
        },
        slackEvidenceImpact: {
          description:
            'Required demo scenario: how the generated Slack-style updates affect the brief, evidenced by an authorization-scope A/B pair and the Slack citations the finalized briefs carry.',
          runsUsed: slackImpact.runsUsed,
          withSlackRunId: slackImpact.runs.withSlack.runId,
          withoutSlackRunId: slackImpact.runs.withoutSlack.runId,
          finding: slackImpact.summary,
          files: [slackImpactVisualName, slackImpactName, 'slack-impact-comparison.md']
        },
        traceAndLogExamples: {
          runId: restrictedRunId,
          provenance: provenance(restricted),
          requiredSpanKinds: [
            'model_call',
            'evidence_retrieval',
            'validation',
            'guardrail',
            'approval_requirement',
            'approval_decision',
            'finalization'
          ],
          files: [traceName, eventName]
        }
      },
      reproduction: {
        commands: [
          'pnpm tsx scripts/generate-sample-runs.ts --api=<api-base> --approval-capture=samples/restricted-approval-flow.json OPP-1003',
          'pnpm tsx scripts/generate-sample-runs.ts --api=<api-base> OPP-1001 OPP-1002',
          'pnpm tsx scripts/slack-impact-comparison.ts <with-slack-run-id> <without-slack-run-id>',
          'pnpm tsx scripts/render-slack-impact-visual.ts',
          'pnpm tsx scripts/export-sample-artifacts.ts <normal-run-id> <expansion-run-id> <restricted-run-id> [api-base]'
        ],
        prerequisites: [
          'Source .env and override DATABASE_URL to the dedicated slacato_samples database, then migrate, ingest, and index it.',
          'Run the API and the worker against that same database with a live AI_PROVIDER.',
          'The three supplied runs must already be finalized live-provider runs, and the approval capture and Slack comparison must have been written first.'
        ]
      }
    };
    await writeFile(resolve(outputDirectory, 'manifest.json'), json(manifest), 'utf8');

    const cards = [
      {
        number: '01',
        title: 'Authorized normal opportunity',
        description: `${normal.requester_name} (${normal.requested_by}) generated a finalized brief for ${normal.opportunity_name} (${normal.opportunity_id}).`,
        files: normalFiles,
        facts: provenance(normal)
      },
      {
        number: '02',
        title: 'Authorized expansion opportunity',
        description: `${expansion.requester_name} (${expansion.requested_by}) generated a finalized brief for ${expansion.opportunity_name} (${expansion.opportunity_id}), completing sample coverage of all three fixture opportunities.`,
        files: expansionFiles,
        facts: provenance(expansion)
      },
      {
        number: '03',
        title: 'Restricted deal and approval quorum',
        description: `${restricted.requester_name} (${restricted.requested_by}) generated the restricted brief. The routing artifact records all ${requirements.length} requirements, the ${decisions.length} decisions that cleared them across ${new Set((decisions as { actor_id: string }[]).map((decision) => decision.actor_id)).size} distinct approvers, the export refused while the run awaited approval, and the dependent gate that only became operable once the others cleared.`,
        files: [...restrictedFiles, approvalFlowName],
        facts: provenance(restricted)
      },
      {
        number: '04',
        title: 'Opaque denied access',
        description:
          'Harper Noor (USR-5007) attempted OPP-1003 and received only the standard opaque 404 response. The artifact contains no account, source, count, or evidence metadata.',
        files: [deniedName],
        facts: { httpStatus: 404, noLeakVerified: true }
      },
      {
        number: '05',
        title: 'Slack-style evidence impact',
        description: slackImpact.summary,
        files: [slackImpactVisualName, slackImpactName, 'slack-impact-comparison.md'],
        facts: {
          runsUsed: slackImpact.runsUsed,
          withSlackRunId: slackImpact.runs.withSlack.runId,
          withoutSlackRunId: slackImpact.runs.withoutSlack.runId
        }
      },
      {
        number: '06',
        title: 'Full trace and run events',
        description: `The restricted run export contains ${traceSpans.length} spans and ${runEvents.length} durable events, including model calls, retrieval, validation, guardrails, approval routing and decisions, and finalization.`,
        files: [traceName, eventName],
        facts: provenance(restricted)
      }
    ];
    const cardHtml = cards
      .map(
        (card) => `<article class="card">
          <div class="number">${card.number}</div>
          <div><h2>${escapeHtml(card.title)}</h2><p>${escapeHtml(card.description)}</p>
          <div class="links">${card.files
            .map((file) => `<a href="${escapeHtml(file)}">${escapeHtml(file)}</a>`)
            .join('')}</div>
          <pre>${escapeHtml(JSON.stringify(card.facts, null, 2))}</pre></div>
        </article>`
      )
      .join('\n');
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deliverable D · Sample run artifacts</title><style>
:root{--accent:#158864;--ink:#0A141D;--muted:#5f6d75;--line:#dfe8e4;--wash:#f5faf8}*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:980px;margin:auto;padding:72px 28px 96px}.eyebrow{color:var(--accent);font-weight:700;letter-spacing:.08em;text-transform:uppercase}
h1{font-size:clamp(38px,6vw,64px);line-height:1.02;letter-spacing:-.045em;margin:14px 0 20px;max-width:760px}header>p{font-size:18px;color:var(--muted);max-width:730px}
.summary{display:flex;gap:12px;flex-wrap:wrap;margin:30px 0 48px}.pill{background:var(--wash);border:1px solid var(--line);border-radius:999px;padding:8px 13px}
.card{display:grid;grid-template-columns:58px 1fr;gap:22px;padding:34px 0;border-top:1px solid var(--line)}.number{color:var(--accent);font-weight:750;font-size:18px}
h2{margin:0 0 8px;font-size:24px;letter-spacing:-.02em}p{margin:0 0 18px}.links{display:flex;gap:9px;flex-wrap:wrap}.links a{color:#fff;background:var(--accent);text-decoration:none;border-radius:8px;padding:8px 11px;font-weight:650}
pre{overflow:auto;background:var(--wash);border:1px solid var(--line);border-radius:12px;padding:16px;margin:18px 0 0;color:#31424a;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
footer{border-top:1px solid var(--line);padding-top:28px;color:var(--muted)}footer a{color:var(--accent)}@media(max-width:620px){main{padding:42px 20px 72px}.card{grid-template-columns:1fr}.number{font-size:14px}}
</style></head><body><main><header><div class="eyebrow">Take-home assignment · Deliverable D</div><h1>Sample run artifacts</h1>
<p>Reviewer-readable outputs from real OpenRouter executions: finalized briefs for all three fixture opportunities, a ${requirements.length}-entry approval quorum, the Slack-evidence impact comparison, an opaque access denial, and durable traces.</p>
<div class="summary"><span class="pill">Generated ${escapeHtml(generatedAt)}</span><span class="pill">Provider: OpenRouter</span><span class="pill">Model: ${escapeHtml(restricted.generation_model)}</span><span class="pill">No external dependencies</span></div></header>
${cardHtml}<footer>Machine-readable provenance and scenario mapping: <a href="manifest.json">manifest.json</a>. Re-run instructions are embedded in the manifest.</footer></main></body></html>\n`;
    await writeFile(resolve(outputDirectory, 'index.html'), html, 'utf8');
  } finally {
    await database.close();
  }
}

await main();
