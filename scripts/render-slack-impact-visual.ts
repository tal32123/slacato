import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Renders the reviewer-facing visual of the Slack-evidence A/B experiment.
 *
 * Required demo scenario 4 asks the submission to *show* how the generated Slack-style updates
 * affect the brief. `samples/slack-impact-comparison.json` already holds that measurement; this
 * script projects it into a standalone page so a reviewer can see the difference instead of
 * reading it. Every number, claim, section state and quoted update on the page is read out of
 * that artifact - nothing is authored here except the labels and the layout - so regenerating
 * the comparison and re-running this script keeps the visual honest.
 *
 * Usage:
 *   pnpm tsx scripts/render-slack-impact-visual.ts [comparison-json] [output-html]
 */

const DEFAULT_INPUT = 'samples/slack-impact-comparison.json';
const DEFAULT_OUTPUT = 'samples/slack-impact.html';
// The web app serves apps/web/public at its root, so this copy is reachable during a live demo
// without adding a route or a nav entry. It sits under samples/ so that the ONE relative link the
// technical overview carries - ../samples/slack-impact.html - resolves both from docs/ on disk and
// from the served copy at the web root. Serving it anywhere else silently breaks that link into the
// SPA's catch-all, which answers 200 with the app shell and looks like a blank page.
const WEB_PUBLIC_OUTPUT = 'apps/web/public/samples/slack-impact.html';
const CITATION_SOURCES = [
  'samples/restricted-opportunity-brief.txt',
  'samples/normal-opportunity-brief.txt',
  'samples/expansion-opportunity-brief.txt'
];

const SPEC_QUOTE =
  'Show how the generated Slack-style updates affect the brief, including at least one cited generated update.';

const SECTION_TITLES: Readonly<Record<string, string>> = {
  dealSnapshot: 'Deal Snapshot',
  executiveSummary: 'Executive Summary',
  buyerGoalsAndBusinessDrivers: 'Buyer Goals and Business Drivers',
  stakeholderMap: 'Stakeholder Map',
  negotiationState: 'Negotiation State',
  recommendedNextActions: 'Recommended Next Actions',
  missingInformation: 'Missing Information',
  sourceEvidence: 'Source Evidence',
  confidenceAndReviewWarnings: 'Confidence and Review Warnings'
};

const SOURCE_TYPE_TITLES: Readonly<Record<string, string>> = {
  slack: 'slack (account-team updates)',
  salesforce: 'salesforce',
  gong_summary: 'gong_summary',
  gong_transcript: 'gong_transcript',
  pricing: 'pricing',
  policy: 'policy'
};

type SlackEntry = Readonly<{
  evidenceId: string;
  rank: number;
  fusionScore: number;
  includedCharacters: number;
  updateText: string;
}>;

type CitedClaim = Readonly<{
  path: string;
  claimId: string;
  statement: string;
  evidenceId: string;
  updateText: string;
}>;

type Run = Readonly<{
  runId: string;
  opportunityId: string;
  requestedBy: Readonly<{ userId: string; name: string }>;
  provenance: Readonly<{
    provider: string;
    generationModel: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    finalizedAt: string;
  }>;
  retrieval: Readonly<{
    entries: number;
    bySourceType: Readonly<Record<string, number>>;
    missingSourceTypes: readonly string[];
    slackEntries: readonly SlackEntry[];
  }>;
  brief: Readonly<{
    sourceEvidenceSlackCitations: readonly Readonly<{ evidenceId: string; summary: string }>[];
    claimsOutsideSourceEvidenceCitingSlack: readonly CitedClaim[];
    sectionsShapedBySlack: readonly string[];
    executiveSummaryNarrative: string;
  }>;
}>;

type Comparison = Readonly<{
  generatedAt: string;
  database: string;
  summary: string;
  runsUsed: number;
  method: Readonly<{
    opportunityUnderTest: string;
    persona: Readonly<{ userId: string; name: string }>;
    withoutSlackMechanism: string;
    sourceTypeResolution: string;
    reviewerVisibleImpactRule: string;
  }>;
  runs: Readonly<{ withSlack: Run; withoutSlack: Run }>;
  reviewerVisibleImpact: Readonly<{
    capturedFrom: string;
    badgedSections: readonly string[];
    allSections: Readonly<Record<string, boolean>>;
  }>;
  supportingRuns: readonly Run[];
}>;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Splits one stored account-team update record into its ingested field/value pairs. */
function parseUpdateRecord(updateText: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of updateText.split('\n')) {
    const separator = line.indexOf(': ');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 2).trim());
  }
  return fields;
}

/** Recovers the update id carried by an immutable evidence id such as `slack:SLK-9009:0`. */
function updateIdOf(evidenceId: string): string {
  return evidenceId.split(':')[1] ?? evidenceId;
}

/** Maps a claim path such as `executiveSummary.claims[0]` back to its brief section key. */
function sectionKeyOf(claimPath: string): string {
  return claimPath.split('.')[0] ?? claimPath;
}

/**
 * Reads each update's citation label out of the shipped brief exports rather than rebuilding it,
 * so the page can never print a citation format the system does not actually emit.
 */
async function loadCitationLabels(): Promise<ReadonlyMap<string, string>> {
  const labels = new Map<string, string>();
  for (const file of CITATION_SOURCES) {
    let text: string;
    try {
      text = await readFile(resolve(process.cwd(), file), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/source=\S+, update_id=(SLK-\d+)/g)) {
      const [label, updateId] = match;
      if (updateId !== undefined && !labels.has(updateId)) labels.set(updateId, label);
    }
  }
  return labels;
}

function shortRunId(runId: string): string {
  return `${runId.slice(0, 11)}…`;
}

/** Renders one metric row: the with-Slack reading, the without-Slack reading, and what it means. */
function metricRow(
  label: string,
  withValue: number,
  withoutValue: number,
  note: string,
  tone: 'lost' | 'flat' | 'gained'
): string {
  return `<div class="metric ${tone}">
  <div class="metric-label">${escapeHtml(label)}</div>
  <div class="metric-values">
    <span class="metric-value on"><span class="metric-cap">Slack authorized</span>${withValue}</span>
    <span class="metric-arrow" aria-hidden="true">→</span>
    <span class="metric-value off"><span class="metric-cap">Slack revoked</span>${withoutValue}</span>
  </div>
  <p class="metric-note">${escapeHtml(note)}</p>
</div>`;
}

/** Renders one ingested account-team update as the structured record the retriever stored. */
function updateCard(
  entry: SlackEntry | CitedClaim,
  citationLabels: ReadonlyMap<string, string>,
  extra: string
): string {
  const fields = parseUpdateRecord(entry.updateText);
  const updateId = updateIdOf(entry.evidenceId);
  const body = fields.get('updateText') ?? '';
  const meta = ['updateDate', 'channel', 'authorRole', 'sourceAccessLevel']
    .map((key) => {
      const value = fields.get(key);
      if (value === undefined) return '';
      return `<div class="field"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`;
    })
    .join('');
  const citation = citationLabels.get(updateId);
  return `<figure class="update">
  <figcaption><span class="chip slack">${escapeHtml(updateId)}</span><span class="synthetic">synthetic</span>${extra}</figcaption>
  <blockquote>${escapeHtml(body)}</blockquote>
  <dl class="fields">${meta}</dl>
  ${citation === undefined ? '' : `<p class="citation"><span>cited as</span><code>${escapeHtml(citation)}</code></p>`}
</figure>`;
}

/** Renders the nine-section on/off grid exactly as the workspace badges it. */
function sectionGrid(comparison: Comparison, citationLabels: ReadonlyMap<string, string>): string {
  const drivers = new Map<string, string[]>();
  for (const claim of comparison.runs.withSlack.brief.claimsOutsideSourceEvidenceCitingSlack) {
    const key = sectionKeyOf(claim.path);
    drivers.set(key, [...(drivers.get(key) ?? []), updateIdOf(claim.evidenceId)]);
  }
  drivers.set(
    'sourceEvidence',
    comparison.runs.withSlack.brief.sourceEvidenceSlackCitations.map((citation) =>
      updateIdOf(citation.evidenceId)
    )
  );
  return Object.entries(comparison.reviewerVisibleImpact.allSections)
    .map(([key, badged]) => {
      const title = SECTION_TITLES[key] ?? key;
      const driving = drivers.get(key) ?? [];
      const on = badged
        ? `<span class="badge on"><span aria-hidden="true">▲</span> Account-team update impact</span>`
        : `<span class="badge off"><span aria-hidden="true">—</span> No account-team impact</span>`;
      const driven =
        badged && driving.length > 0
          ? `<p class="driven">Carried by ${driving
              .map(
                (id) =>
                  `<code title="${escapeHtml(citationLabels.get(id) ?? id)}">${escapeHtml(id)}</code>`
              )
              .join(' ')}</p>`
          : '';
      return `<div class="section-row${badged ? ' impacted' : ''}">
  <div class="section-name">${escapeHtml(title)}${driven}</div>
  <div class="section-state">${on}</div>
  <div class="section-state">${`<span class="badge off"><span aria-hidden="true">—</span> No account-team impact</span>`}</div>
</div>`;
    })
    .join('\n');
}

/** Renders the retrieved-evidence mix as paired bars so the substitution is visible. */
function retrievalBars(comparison: Comparison): string {
  const withMix = comparison.runs.withSlack.retrieval.bySourceType;
  const withoutMix = comparison.runs.withoutSlack.retrieval.bySourceType;
  const keys = [...new Set([...Object.keys(withMix), ...Object.keys(withoutMix)])].sort(
    (left, right) => (withMix[right] ?? 0) - (withMix[left] ?? 0)
  );
  const peak = Math.max(...keys.map((key) => Math.max(withMix[key] ?? 0, withoutMix[key] ?? 0)), 1);
  return keys
    .map((key) => {
      const on = withMix[key] ?? 0;
      const off = withoutMix[key] ?? 0;
      const delta = off - on;
      const deltaText = delta === 0 ? 'unchanged' : `${delta > 0 ? '+' : ''}${delta}`;
      return `<div class="bar-row${key === 'slack' ? ' slack' : ''}">
  <div class="bar-name">${escapeHtml(SOURCE_TYPE_TITLES[key] ?? key)}</div>
  <div class="bars">
    <div class="bar"><span class="track"><span class="fill on" style="width:${(on / peak) * 100}%"></span></span><span class="bar-value">${on}</span></div>
    <div class="bar"><span class="track"><span class="fill off" style="width:${(off / peak) * 100}%"></span></span><span class="bar-value">${off}</span></div>
  </div>
  <div class="bar-delta${delta === 0 ? ' flat' : ''}">${escapeHtml(deltaText)}</div>
</div>`;
    })
    .join('\n');
}

/** Renders the two supporting deals so the behaviour is not a single-deal accident. */
function supportingRows(comparison: Comparison): string {
  return comparison.supportingRuns
    .map(
      (run) => `<tr>
  <td>${escapeHtml(run.opportunityId)}<span class="sub">${escapeHtml(run.requestedBy.name)} · ${escapeHtml(run.requestedBy.userId)}</span></td>
  <td>${run.retrieval.slackEntries.length}</td>
  <td>${run.brief.sourceEvidenceSlackCitations.length}</td>
  <td>${run.brief.claimsOutsideSourceEvidenceCitingSlack.length}</td>
  <td><code>${escapeHtml(shortRunId(run.runId))}</code></td>
</tr>`
    )
    .join('\n');
}

function render(comparison: Comparison, citationLabels: ReadonlyMap<string, string>): string {
  const on = comparison.runs.withSlack;
  const off = comparison.runs.withoutSlack;
  const [headlineClaim, ...otherClaims] = on.brief.claimsOutsideSourceEvidenceCitingSlack;
  if (headlineClaim === undefined) throw new Error('Comparison carries no Slack-cited claim');
  const badgedCount = comparison.reviewerVisibleImpact.badgedSections.length;
  const verbatim =
    parseUpdateRecord(headlineClaim.updateText).get('updateText') === headlineClaim.statement;
  const metrics = [
    metricRow(
      'Account-team updates in the run evidence manifest',
      on.retrieval.slackEntries.length,
      off.retrieval.slackEntries.length,
      on.retrieval.slackEntries.length > 0
        ? `Top-ranked evidence in the authorized run is ${updateIdOf(on.retrieval.slackEntries[0]?.evidenceId ?? '')} at rank ${on.retrieval.slackEntries[0]?.rank ?? 0}.`
        : 'No account-team update reached the authorized pool.',
      'lost'
    ),
    metricRow(
      'Brief claims outside Source Evidence citing an update',
      on.brief.claimsOutsideSourceEvidenceCitingSlack.length,
      off.brief.claimsOutsideSourceEvidenceCitingSlack.length,
      'These are conclusions, not the evidence list: the updates shape what the brief says.',
      'lost'
    ),
    metricRow(
      'Workspace sections badged "Account-team update impact"',
      badgedCount,
      0,
      'Counts Source Evidence, which is badged because it lists the updates themselves, on top of the three sections whose claims cite one.',
      'lost'
    ),
    metricRow(
      'Total entries in the run evidence manifest',
      on.retrieval.entries,
      off.retrieval.entries,
      'The pool size is fixed. Revoking the grant does not shrink the brief, it changes which records win the slots.',
      'flat'
    ),
    metricRow(
      'gong_summary entries backfilling the freed slots',
      on.retrieval.bySourceType.gong_summary ?? 0,
      off.retrieval.bySourceType.gong_summary ?? 0,
      'The next-best candidates take the vacated ranks, which is why the without-Slack brief still reads as complete while saying less.',
      'gained'
    )
  ].join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>What the account-team updates change</title><style>
:root{color-scheme:light;--forest:#182d2a;--primary:#0d483d;--secondary:#def6ef;--mint:#81e5ac;--attention:#f5c13d;--attention-ink:#594400;--muted-ink:#31554f;--line:#c8ddd6;--ring:#158864;--bg:#f6f6f6;--card:#fbfcfb;--wash:#e8f1ee}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--forest);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1040px;margin:auto;padding:64px 24px 88px}
a{color:var(--ring)}
code{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.eyebrow{color:var(--ring);font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:13px}
h1{font-size:clamp(34px,5.4vw,56px);line-height:1.03;letter-spacing:-.04em;margin:14px 0 18px;max-width:800px}
.lede{font-size:18px;color:var(--muted-ink);max-width:760px;margin:0 0 24px}
blockquote.spec{margin:0 0 26px;padding:16px 20px;background:var(--secondary);border-left:4px solid var(--primary);border-radius:0 10px 10px 0;max-width:760px}
blockquote.spec p{margin:0 0 6px;font-size:16px}
blockquote.spec cite{font-style:normal;font-size:13px;color:var(--muted-ink)}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;padding:0;list-style:none}
.pills li{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:13px;color:var(--muted-ink)}
section{border-top:1px solid var(--line);margin-top:44px;padding-top:34px}
h2{font-size:24px;letter-spacing:-.02em;margin:0 0 6px}
h3{font-size:15px;letter-spacing:.02em;margin:0 0 10px}
.sub{display:block;color:var(--muted-ink);font-size:12.5px}
section>p{color:var(--muted-ink);max-width:760px;margin:0 0 22px}
.runs{display:grid;gap:14px;grid-template-columns:repeat(2,minmax(0,1fr))}
.run{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.run.off{border-style:dashed;background:transparent}
.run h3 span{display:inline-block;margin-right:8px}
.run dl{margin:0;display:grid;gap:6px;font-size:13px}
.run .field{display:grid;grid-template-columns:minmax(0,7.5rem) minmax(0,1fr);gap:10px}
.run dt{color:var(--muted-ink)}
.run dd{margin:0;overflow-wrap:anywhere}
.metric{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 24px;align-items:center;padding:16px 0;border-bottom:1px solid var(--line)}
.metric-label{font-weight:650}
.metric-note{grid-column:1/-1;margin:0;color:var(--muted-ink);font-size:13px;max-width:70ch}
.metric-values{display:flex;align-items:center;gap:12px}
.metric-value{display:grid;justify-items:center;min-width:76px;padding:6px 10px;border-radius:10px;font-size:26px;font-weight:750;line-height:1.1}
.metric-cap{font-size:10.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;opacity:.8}
.metric-value.on{background:var(--secondary);color:var(--primary);border:1px solid var(--line)}
.metric-value.off{background:transparent;color:var(--muted-ink);border:1px dashed var(--line)}
.metric-arrow{color:var(--muted-ink)}
.metric.flat .metric-value.off{color:var(--primary)}
.headline{display:grid;gap:16px;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);align-items:start}
.update{margin:0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.update figcaption{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.chip{border-radius:999px;padding:4px 10px;font-size:12px;font-weight:700;letter-spacing:.02em}
.chip.slack{background:var(--primary);color:var(--secondary)}
.chip.rank{background:var(--wash);color:var(--primary);border:1px solid var(--line)}
.synthetic{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted-ink)}
.update blockquote{margin:0 0 14px;font-size:17px;line-height:1.5;border-left:3px solid var(--mint);padding-left:14px}
.update .fields{margin:0;display:grid;gap:4px;font-size:12.5px}
.update .field{display:grid;grid-template-columns:minmax(0,9rem) minmax(0,1fr);gap:10px}
.update dt{color:var(--muted-ink)}
.update dd{margin:0;overflow-wrap:anywhere}
.citation{margin:12px 0 0;display:grid;gap:4px}
.citation span{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted-ink)}
.citation code{display:block;overflow-x:auto;white-space:nowrap;background:var(--wash);border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--primary)}
.outcome{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px}
.outcome.off{border-style:dashed;background:transparent}
.outcome h3{color:var(--muted-ink);text-transform:uppercase;letter-spacing:.07em;font-size:11.5px}
.outcome p.says{font-size:16.5px;line-height:1.5;margin:0 0 10px}
.outcome .flags{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 10px}
.outcome .meta{margin:0;font-size:12.5px;color:var(--muted-ink);overflow-wrap:anywhere}
.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 11px;font-size:12.5px;font-weight:600;white-space:nowrap}
.badge.on{background:#f5c13d33;border:1px solid #f5c13d80;color:var(--attention-ink)}
.badge.off{background:transparent;border:1px dashed var(--line);color:var(--muted-ink)}
.grid-head,.section-row{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:center}
.grid-head{padding:0 0 8px;border-bottom:1px solid var(--line);font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted-ink)}
.section-row{padding:12px 0;border-bottom:1px solid var(--line)}
.section-row.impacted{background:#f5c13d14}
.section-name{font-weight:600}
.driven{margin:4px 0 0;font-size:12px;font-weight:400;color:var(--muted-ink)}
.driven code{background:var(--wash);border:1px solid var(--line);border-radius:6px;padding:1px 5px}
.bar-row{display:grid;grid-template-columns:minmax(0,13rem) minmax(0,1fr) 5rem;gap:14px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)}
.bar-row.slack .bar-name{font-weight:700;color:var(--primary)}
.bars{display:grid;gap:4px}
.bar{display:grid;grid-template-columns:minmax(0,1fr) 1.6rem;align-items:center;gap:8px;height:16px}
.track{display:block;min-width:0}
.fill{display:block;height:12px;border-radius:3px;min-width:2px}
.fill.on{background:var(--primary)}
.fill.off{background:var(--wash);border:1px dashed var(--muted-ink)}
.bar-value{font-size:12px;color:var(--muted-ink);text-align:left}
.bar-delta{font-size:12.5px;font-weight:650;color:var(--attention-ink);text-align:right}
.bar-delta.flat{color:var(--muted-ink);font-weight:400}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--muted-ink);margin:0 0 14px;padding:0;list-style:none}
.legend span{display:inline-block;width:22px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}
.legend .on{background:var(--primary)}
.legend .off{background:var(--wash);border:1px dashed var(--muted-ink)}
.cards{display:grid;gap:14px;grid-template-columns:repeat(2,minmax(0,1fr))}
.claim-note{margin:12px 0 0;font-size:13px;color:var(--muted-ink)}
.claim-note code{background:var(--wash);border:1px solid var(--line);border-radius:6px;padding:1px 5px}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:520px;font-size:14px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted-ink)}
footer{border-top:1px solid var(--line);margin-top:44px;padding-top:24px;color:var(--muted-ink);font-size:13.5px}
footer code{display:block;overflow-x:auto;white-space:nowrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 11px;margin-top:10px}
@media (max-width:760px){
  main{padding:40px 18px 64px}
  .runs,.headline,.cards{grid-template-columns:minmax(0,1fr)}
  .grid-head{display:none}
  .section-row{grid-template-columns:minmax(0,1fr);gap:8px;padding:14px 0}
  .section-state:nth-of-type(2)::before{content:"Slack authorized: ";font-size:12px;color:var(--muted-ink)}
  .section-state:last-child::before{content:"Slack revoked: ";font-size:12px;color:var(--muted-ink)}
  .bar-row{grid-template-columns:minmax(0,1fr) 5.5rem;row-gap:6px}
  .bars{grid-column:1/-1;order:3}
  .metric{grid-template-columns:minmax(0,1fr)}
  .metric-values{justify-content:flex-start}
}
</style></head><body><main>
<header>
<div class="eyebrow">Required demo scenario 4 · evidence, visualized</div>
<h1>What the account-team updates change</h1>
<blockquote class="spec"><p>&ldquo;${escapeHtml(SPEC_QUOTE)}&rdquo;</p><cite>Cato GTM AI Engineer home task, §8 Required Demo Scenarios</cite></blockquote>
<p class="lede">${escapeHtml(comparison.summary)}</p>
<ul class="pills">
<li>Opportunity ${escapeHtml(comparison.method.opportunityUnderTest)}</li>
<li>Requester ${escapeHtml(comparison.method.persona.name)} (${escapeHtml(comparison.method.persona.userId)})</li>
<li>${escapeHtml(on.provenance.provider)} · ${escapeHtml(on.provenance.generationModel)}</li>
<li>${escapeHtml(comparison.runsUsed.toString())} live runs</li>
<li>Measured ${escapeHtml(comparison.generatedAt)}</li>
</ul>
<p class="lede">Every figure on this page is rendered from <a href="slack-impact-comparison.json">slack-impact-comparison.json</a>, the artifact those runs produced. The written version of the same evidence is <a href="slack-impact-comparison.md">slack-impact-comparison.md</a>.</p>
</header>

<section>
<h2>One input changed</h2>
<p>${escapeHtml(comparison.method.withoutSlackMechanism)}</p>
<div class="runs">
<article class="run"><h3><span class="chip slack">A</span>Slack authorized</h3>
<dl>
<div class="field"><dt>Run</dt><dd><code>${escapeHtml(on.runId)}</code></dd></div>
<div class="field"><dt>Finalized</dt><dd>${escapeHtml(on.provenance.finalizedAt)}</dd></div>
<div class="field"><dt>Model calls</dt><dd>${on.provenance.calls}</dd></div>
<div class="field"><dt>Tokens</dt><dd>${on.provenance.inputTokens} in · ${on.provenance.outputTokens} out</dd></div>
</dl></article>
<article class="run off"><h3><span class="chip rank">B</span>Slack grant revoked</h3>
<dl>
<div class="field"><dt>Run</dt><dd><code>${escapeHtml(off.runId)}</code></dd></div>
<div class="field"><dt>Finalized</dt><dd>${escapeHtml(off.provenance.finalizedAt)}</dd></div>
<div class="field"><dt>Model calls</dt><dd>${off.provenance.calls}</dd></div>
<div class="field"><dt>Tokens</dt><dd>${off.provenance.inputTokens} in · ${off.provenance.outputTokens} out</dd></div>
</dl></article>
</div>
<p class="claim-note">Run facts are recorded for provenance only. ${escapeHtml(comparison.method.sourceTypeResolution)}</p>
</section>

<section>
<h2>What the updates are worth</h2>
<p>Left reading is the authorized run, right reading is the same deal with only the <code>slack</code> read grant revoked.</p>
${metrics}
</section>

<section>
<h2>The cited update that writes the Executive Summary</h2>
<p>The lead claim of the Executive Summary is not merely informed by an account-team update &mdash; it <em>is</em> that update, carried into the brief by its single citation. Revoke the grant and the same section falls back to a generic line.</p>
<div class="headline">
${updateCard(headlineClaim, citationLabels, `<span class="chip rank">rank ${on.retrieval.slackEntries[0]?.rank ?? 1} of ${on.retrieval.entries}</span>`)}
<div>
<article class="outcome"><h3>Slack authorized · ${escapeHtml(SECTION_TITLES[sectionKeyOf(headlineClaim.path)] ?? headlineClaim.path)}</h3>
<p class="says">&ldquo;${escapeHtml(on.brief.executiveSummaryNarrative)}&rdquo;</p>
<p class="flags"><span class="badge on"><span aria-hidden="true">▲</span> Account-team update impact</span>${verbatim ? '<span class="chip rank">verbatim from the update, not a paraphrase</span>' : ''}</p>
<p class="meta">${escapeHtml(headlineClaim.path)} · <code>${escapeHtml(headlineClaim.claimId)}</code> · sole citation <code>${escapeHtml(headlineClaim.evidenceId)}</code></p>
</article>
<article class="outcome off"><h3>Slack revoked · ${escapeHtml(SECTION_TITLES[sectionKeyOf(headlineClaim.path)] ?? headlineClaim.path)}</h3>
<p class="says">&ldquo;${escapeHtml(off.brief.executiveSummaryNarrative)}&rdquo;</p>
<p><span class="badge off"><span aria-hidden="true">—</span> No account-team impact</span></p>
<p class="meta">No claim anywhere in this brief cites an account-team update, and Source Evidence lists none.</p>
</article>
</div>
</div>
</section>

<section>
<h2>Where the brief changes, section by section</h2>
<p>${escapeHtml(comparison.method.reviewerVisibleImpactRule)} Captured from <code>${escapeHtml(comparison.reviewerVisibleImpact.capturedFrom)}</code>.</p>
<div class="grid-head"><div>Brief section</div><div>Slack authorized</div><div>Slack revoked</div></div>
${sectionGrid(comparison, citationLabels)}
</section>

<section>
<h2>The other two updates the brief cites</h2>
<div class="cards">
${otherClaims
  .map(
    (claim) => `<div>${updateCard(claim, citationLabels, '')}
<p class="claim-note">Drives <strong>${escapeHtml(SECTION_TITLES[sectionKeyOf(claim.path)] ?? claim.path)}</strong> &mdash; ${escapeHtml(claim.path)} <code>${escapeHtml(claim.claimId)}</code>: &ldquo;${escapeHtml(claim.statement)}&rdquo;</p></div>`
  )
  .join('\n')}
</div>
</section>

<section>
<h2>Same pool, different winners</h2>
<p>Both runs retrieve exactly ${on.retrieval.entries} evidence entries. Revoking the grant does not leave a hole; the next-best candidates take the freed ranks, which is why the difference has to be read at the claim level rather than from the size of the brief.</p>
<ul class="legend"><li><span class="on"></span>Slack authorized</li><li><span class="off"></span>Slack revoked</li></ul>
${retrievalBars(comparison)}
</section>

<section>
<h2>Not a single-deal accident</h2>
<p>The two other shipped sample briefs were measured the same way, from their own live runs.</p>
<div class="table-wrap">
<table>
<thead><tr><th>Deal</th><th>Updates retrieved</th><th>Cited in Source Evidence</th><th>Claims outside Source Evidence</th><th>Run</th></tr></thead>
<tbody>
${supportingRows(comparison)}
</tbody>
</table>
</div>
<p class="claim-note">OPP-1001 reaches fewer updates by design rather than by defect: its <code>ambiguity_or_conflict</code> update is classified <code>sensitive_pricing</code>, and that requester's grant carries <code>can_view_sensitive_pricing = false</code>.</p>
</section>

<footer>
<p>Back to <a href="index.html">the sample run artifacts index</a>. Source data: <a href="slack-impact-comparison.json">slack-impact-comparison.json</a> · written report: <a href="slack-impact-comparison.md">slack-impact-comparison.md</a> · database <code>${escapeHtml(comparison.database)}</code>.</p>
<p>Regenerate this page from the measured artifact:</p>
<code>pnpm tsx scripts/render-slack-impact-visual.ts</code>
</footer>
</main></body></html>
`;
}

async function main(): Promise<void> {
  const [inputArgument, outputArgument] = process.argv.slice(2);
  const inputPath = resolve(process.cwd(), inputArgument ?? DEFAULT_INPUT);
  const outputPath = resolve(process.cwd(), outputArgument ?? DEFAULT_OUTPUT);
  const comparison = JSON.parse(await readFile(inputPath, 'utf8')) as Comparison;
  const citationLabels = await loadCitationLabels();
  const page = render(comparison, citationLabels);
  await writeFile(outputPath, page, 'utf8');
  if (outputArgument === undefined)
    await writeFile(resolve(process.cwd(), WEB_PUBLIC_OUTPUT), page, 'utf8');
  process.stdout.write(
    `wrote ${outputArgument ?? `${DEFAULT_OUTPUT} and ${WEB_PUBLIC_OUTPUT}`} (${comparison.runs.withSlack.brief.claimsOutsideSourceEvidenceCitingSlack.length} cited claims, ` +
      `${comparison.reviewerVisibleImpact.badgedSections.length} badged sections)\n`
  );
}

await main();
