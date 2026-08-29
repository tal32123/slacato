import { assertApprovableBrief, canonicalJson } from './workflow.js';
import type { Citation, Claim, DealBrief } from '../../domain/briefs/schema.js';

export type DealBriefExportFormat = 'json' | 'markdown';

type MarkdownContext = {
  readonly citations: ReadonlyMap<string, Citation>;
};

function escapeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\\`*_{}[\]()<>#+.!|~-]/g, '\\$&');
}

function valueLine(label: string, value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return `- **${label}:** ${escapeMarkdown(String(value))}`;
}

function listLines(label: string, values: readonly string[]): string[] {
  return values.length === 0
    ? [`### ${label}`, '- None']
    : [`### ${label}`, ...values.map((value) => `- ${escapeMarkdown(value)}`)];
}

function claimLines(claims: readonly Claim[] | undefined, context: MarkdownContext, heading = '### Claims'): string[] {
  if (claims === undefined || claims.length === 0) return [];
  const lines = [heading];
  for (const claim of claims) {
    const labels = claim.citations.map((citation) => {
      if (!context.citations.has(citation.id)) throw new Error('Citation label registry is incomplete');
      return `[^${citation.id}]`;
    }).join(' ');
    lines.push(`- ${escapeMarkdown(claim.statement)} (confidence: ${claim.confidence.toFixed(2)})${labels.length === 0 ? '' : ` ${labels}`}`);
  }
  return lines;
}

function citationLabels(brief: DealBrief): ReadonlyMap<string, Citation> {
  const claims: readonly Claim[] = [
    ...(brief.dealSnapshot.claims ?? []),
    ...(brief.executiveSummary.claims ?? []),
    ...(brief.buyerGoalsAndBusinessDrivers.claims ?? []),
    ...(brief.stakeholderMap.claims ?? []),
    ...brief.stakeholderMap.stakeholders.flatMap((stakeholder) => stakeholder.claims ?? []),
    ...(brief.negotiationState.claims ?? []),
    ...brief.recommendedNextActions.actions.flatMap((action) => action.claims ?? []),
    ...brief.sourceEvidence.evidence.flatMap((evidence) => evidence.claims ?? [])
  ];
  const citations = new Map<string, Citation>();
  for (const claim of claims) {
    for (const citation of claim.citations) {
      const existing = citations.get(citation.id);
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(citation)) {
        throw new Error('A citation label resolves to conflicting immutable evidence');
      }
      citations.set(citation.id, citation);
    }
  }
  return citations;
}

function compact(lines: readonly (string | undefined)[]): string[] {
  return lines.filter((line): line is string => line !== undefined);
}

function renderMarkdown(brief: DealBrief, citations: ReadonlyMap<string, Citation>): string {
  const context: MarkdownContext = { citations };
  const lines: string[] = [
    '# Deal Brief',
    '',
    '## 1. Deal Snapshot',
    ...compact([
      valueLine('Account', brief.dealSnapshot.accountName),
      valueLine('Opportunity', brief.dealSnapshot.opportunityName),
      valueLine('Stage', brief.dealSnapshot.stage),
      valueLine('Close date', brief.dealSnapshot.closeDate),
      valueLine('Amount', brief.dealSnapshot.amount),
      valueLine('Currency', brief.dealSnapshot.currency),
      valueLine('Owner', brief.dealSnapshot.owner)
    ]),
    ...claimLines(brief.dealSnapshot.claims, context),
    '',
    '## 2. Executive Summary',
    escapeMarkdown(brief.executiveSummary.narrative),
    ...claimLines(brief.executiveSummary.claims, context),
    '',
    '## 3. Buyer Goals and Business Drivers',
    ...listLines('Goals', brief.buyerGoalsAndBusinessDrivers.goals),
    ...listLines('Business Drivers', brief.buyerGoalsAndBusinessDrivers.businessDrivers),
    ...claimLines(brief.buyerGoalsAndBusinessDrivers.claims, context),
    '',
    '## 4. Stakeholder Map'
  ];

  if (brief.stakeholderMap.stakeholders.length === 0) lines.push('- None');
  for (const stakeholder of brief.stakeholderMap.stakeholders) {
    lines.push(
      `### ${escapeMarkdown(stakeholder.name)}`,
      ...compact([
        valueLine('Title', stakeholder.title),
        valueLine('Organization', stakeholder.organization),
        valueLine('Role', stakeholder.role),
        valueLine('Influence', stakeholder.influence),
        valueLine('Relationship', stakeholder.relationship)
      ]),
      ...listLines('Goals', stakeholder.goals),
      ...listLines('Concerns', stakeholder.concerns),
      ...claimLines(stakeholder.claims, context, '#### Claims')
    );
  }
  if (brief.stakeholderMap.coverageGaps !== undefined) lines.push(...listLines('Coverage Gaps', brief.stakeholderMap.coverageGaps));
  lines.push(
    ...claimLines(brief.stakeholderMap.claims, context),
    '',
    '## 5. Negotiation State',
    escapeMarkdown(brief.negotiationState.currentState),
    ...(brief.negotiationState.leverage === undefined ? [] : listLines('Leverage', brief.negotiationState.leverage)),
    ...listLines('Risks', brief.negotiationState.risks),
    ...claimLines(brief.negotiationState.claims, context),
    '',
    '## 6. Recommended Next Actions'
  );
  if (brief.recommendedNextActions.actions.length === 0) lines.push('- None');
  brief.recommendedNextActions.actions.forEach((action, index) => {
    lines.push(
      `### ${index + 1}. ${escapeMarkdown(action.action)}`,
      ...compact([
        valueLine('Owner', action.owner),
        valueLine('Priority', action.priority),
        valueLine('Due date', action.dueDate),
        valueLine('Rationale', action.rationale)
      ]),
      ...claimLines(action.claims, context, '#### Claims')
    );
  });
  lines.push('', '## 7. Missing Information');
  if (brief.missingInformation.items.length === 0) lines.push('- None');
  brief.missingInformation.items.forEach((item, index) => {
    lines.push(
      `### ${index + 1}. ${escapeMarkdown(item.question)}`,
      `- **Why it matters:** ${escapeMarkdown(item.whyItMatters)}`,
      ...compact([valueLine('Owner', item.owner)])
    );
  });
  lines.push('', '## 8. Source Evidence');
  if (brief.sourceEvidence.evidence.length === 0) lines.push('- None');
  for (const evidence of brief.sourceEvidence.evidence) {
    lines.push(
      `### ${escapeMarkdown(evidence.evidenceId)}`,
      `- **Source type:** ${escapeMarkdown(evidence.sourceType)}`,
      `- **Captured at:** ${escapeMarkdown(evidence.capturedAt)}`,
      `- **Summary:** ${escapeMarkdown(evidence.summary)}`,
      ...claimLines(evidence.claims, context, '#### Claims')
    );
  }
  lines.push('### Citation Labels');
  if (context.citations.size === 0) lines.push('- None');
  for (const citation of [...context.citations.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`[^${citation.id}]: Evidence \`${citation.evidenceId}\` — ${escapeMarkdown(citation.locator)}${citation.rationale === undefined ? '' : ` — ${escapeMarkdown(citation.rationale)}`}`);
  }
  lines.push(
    '',
    '## 9. Confidence and Review Warnings',
    `- **Overall confidence:** ${brief.confidenceAndReviewWarnings.overallConfidence.toFixed(2)}`
  );
  if (brief.confidenceAndReviewWarnings.warnings.length === 0) lines.push('- **Warnings:** None');
  for (const warning of brief.confidenceAndReviewWarnings.warnings) {
    const claimIds = warning.claimIds.length === 0 ? 'none' : warning.claimIds.map((id) => `\`${id}\``).join(', ');
    lines.push(`- **${warning.code} (${warning.severity}):** ${escapeMarkdown(warning.message)} — claims: ${claimIds}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Validates and deterministically serializes the canonical immutable nine-section brief. */
export function exportBrief(brief: unknown, format: DealBriefExportFormat): string {
  const canonical = assertApprovableBrief(brief);
  const citations = citationLabels(canonical);
  if (format === 'json') return canonicalJson(canonical);
  if (format === 'markdown') return renderMarkdown(canonical, citations);
  throw new Error('Unsupported brief export format');
}
