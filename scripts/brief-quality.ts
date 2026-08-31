import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DealBrief, dealBriefSchema } from '../packages/core/src/index.js';
import { parseFixtureSet } from './fixture-loader.js';

/**
 * Brief-quality evaluation.
 *
 * Retrieval quality is measured by `scripts/evaluate.ts`; this module measures the other half of
 * the deliverable - whether a finalized brief is actually usable by the reviewer who reads it.
 * Every rule below pins a defect observed in a brief that was handed in as a deliverable, so each
 * one is written as an invariant of the artifact rather than as an assertion about the mechanism
 * that produced it. That keeps the rules valid however the grounding pipeline is repaired.
 */

/** One brief-quality invariant that a produced brief violated, with the evidence for the finding. */
export type BriefQualityViolation = Readonly<{
  rule: BriefQualityRule;
  detail: string;
}>;

/** The stable identifiers of the brief-quality invariants, used by reports and by CI output. */
export type BriefQualityRule =
  | 'silently-discarded-stakeholder'
  | 'discarded-content-marker'
  | 'multi-source-citations'
  | 'required-sections-populated'
  | 'internal-identifier-in-copy'
  | 'self-contradictory-warning';

/**
 * What the authorized fixtures make reachable for the deal under evaluation.
 *
 * These are supplied by the caller rather than inferred from the brief, because a brief that
 * dropped its stakeholders or its Slack citations cannot be asked what it should have contained.
 */
export type BriefQualityExpectations = Readonly<{
  /** Contact records the deal's fixtures define, keyed by the evidence id that carries them. */
  contactsByEvidenceId: Readonly<Record<string, string>>;
  /** Brief-level source types the authorized manifest can reach for this deal. */
  reachableSourceTypes: readonly string[];
  /** Lowest number of distinct brief-level source types a finalized brief must cite. */
  minimumSourceTypes: number;
}>;

/** The outcome of evaluating one brief against every quality invariant. */
export type BriefQualityReport = Readonly<{
  violations: readonly BriefQualityViolation[];
  sourceTypes: readonly string[];
  stakeholderNames: readonly string[];
  sections: Readonly<Record<string, number>>;
}>;

/** Prose the reviewer reads verbatim, paired with the path that produced it. */
export type ProseField = Readonly<{ path: string; text: string }>;

/**
 * Identifier shapes that exist only inside a run and mean nothing to the person reading the brief.
 * Structured citation payloads legitimately carry these; user-facing prose never may.
 */
const INTERNAL_IDENTIFIER_PATTERNS: readonly Readonly<{ label: string; pattern: RegExp }>[] = [
  { label: 'claim identifier', pattern: /\bclaim_[A-Za-z0-9][A-Za-z0-9_-]*/u },
  { label: 'citation identifier', pattern: /\bcitation_[A-Za-z0-9][A-Za-z0-9_-]*/u },
  { label: 'evidence manifest identifier', pattern: /\bmanifest_[A-Za-z0-9][A-Za-z0-9_-]*/u },
  { label: 'run identifier', pattern: /\brun_[0-9a-f]{16,}/u },
  {
    label: 'evidence identifier',
    pattern: /\b(?:salesforce|slack|gong_summary|gong_transcript|policy|pricing):\S*:\d+\b/u
  },
  { label: 'content hash', pattern: /\b[0-9a-f]{32,}\b/u }
];

/** Wording that asserts something is missing, unsupported, or otherwise absent from the brief. */
const ABSENCE_WORDING =
  /\b(?:absent|missing|unsupported|not supported|no support|lacks|lacking|insufficient|without support|no evidence|unavailable)\b/iu;

/** Lower-cases and collapses whitespace so warning prose and stakeholder names compare stably. */
function normalize(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

/** Reports whether a complete word or phrase occurs in already normalized text. */
function containsPhrase(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(haystack);
}

/**
 * Collects every string the reviewer reads as prose.
 *
 * Structured metadata - claim ids, citation ids, evidence ids, locators - is deliberately excluded:
 * those are the brief's provenance spine, and the rendered views turn them into citation controls
 * rather than showing them as sentences.
 */
export function collectUserFacingProse(brief: DealBrief): readonly ProseField[] {
  const fields: ProseField[] = [];
  const add = (path: string, text: string | undefined): void => {
    if (text !== undefined && text.trim().length > 0) fields.push({ path, text });
  };
  const addAll = (path: string, values: readonly string[] | undefined): void => {
    for (const [index, value] of (values ?? []).entries()) add(`${path}[${index}]`, value);
  };
  const addClaims = (path: string, claims: DealBrief['executiveSummary']['claims']): void => {
    for (const [index, claim] of (claims ?? []).entries())
      add(`${path}[${index}].statement`, claim.statement);
  };

  add('dealSnapshot.accountName', brief.dealSnapshot.accountName);
  add('dealSnapshot.opportunityName', brief.dealSnapshot.opportunityName);
  add('dealSnapshot.stage', brief.dealSnapshot.stage);
  add('dealSnapshot.owner', brief.dealSnapshot.owner);
  addClaims('dealSnapshot.claims', brief.dealSnapshot.claims);

  add('executiveSummary.narrative', brief.executiveSummary.narrative);
  addClaims('executiveSummary.claims', brief.executiveSummary.claims);

  addAll('buyerGoalsAndBusinessDrivers.goals', brief.buyerGoalsAndBusinessDrivers.goals);
  addAll(
    'buyerGoalsAndBusinessDrivers.businessDrivers',
    brief.buyerGoalsAndBusinessDrivers.businessDrivers
  );
  addClaims('buyerGoalsAndBusinessDrivers.claims', brief.buyerGoalsAndBusinessDrivers.claims);

  addAll('stakeholderMap.coverageGaps', brief.stakeholderMap.coverageGaps);
  addClaims('stakeholderMap.claims', brief.stakeholderMap.claims);
  for (const [index, stakeholder] of brief.stakeholderMap.stakeholders.entries()) {
    const path = `stakeholderMap.stakeholders[${index}]`;
    add(`${path}.name`, stakeholder.name);
    add(`${path}.title`, stakeholder.title);
    add(`${path}.organization`, stakeholder.organization);
    addAll(`${path}.goals`, stakeholder.goals);
    addAll(`${path}.concerns`, stakeholder.concerns);
    addClaims(`${path}.claims`, stakeholder.claims);
  }

  add('negotiationState.currentState', brief.negotiationState.currentState);
  addAll('negotiationState.leverage', brief.negotiationState.leverage);
  addAll('negotiationState.risks', brief.negotiationState.risks);
  addClaims('negotiationState.claims', brief.negotiationState.claims);

  for (const [index, action] of brief.recommendedNextActions.actions.entries()) {
    const path = `recommendedNextActions.actions[${index}]`;
    add(`${path}.action`, action.action);
    add(`${path}.rationale`, action.rationale);
    add(`${path}.owner`, action.owner);
    addClaims(`${path}.claims`, action.claims);
  }

  for (const [index, item] of brief.missingInformation.items.entries()) {
    const path = `missingInformation.items[${index}]`;
    add(`${path}.question`, item.question);
    add(`${path}.whyItMatters`, item.whyItMatters);
    add(`${path}.owner`, item.owner);
  }

  for (const [index, summary] of brief.sourceEvidence.evidence.entries()) {
    const path = `sourceEvidence.evidence[${index}]`;
    add(`${path}.summary`, summary.summary);
    addClaims(`${path}.claims`, summary.claims);
  }

  for (const [index, warning] of brief.confidenceAndReviewWarnings.warnings.entries())
    add(`confidenceAndReviewWarnings.warnings[${index}].message`, warning.message);

  return fields;
}

/** Names every stakeholder the brief itself presents as supported by cited evidence. */
export function supportedStakeholderNames(brief: DealBrief): readonly string[] {
  return brief.stakeholderMap.stakeholders
    .filter((stakeholder) => stakeholder.claims.some((claim) => claim.citations.length > 0))
    .map((stakeholder) => stakeholder.name);
}

/** Evaluates one finalized brief against every brief-quality invariant. */
export function evaluateBriefQuality(
  value: unknown,
  expectations: BriefQualityExpectations
): BriefQualityReport {
  const brief = dealBriefSchema.parse(value);
  const violations: BriefQualityViolation[] = [];
  const stakeholderNames = brief.stakeholderMap.stakeholders.map((stakeholder) => stakeholder.name);
  const normalizedNames = stakeholderNames.map(normalize);
  const citedEvidenceIds = new Set(brief.sourceEvidence.evidence.map((entry) => entry.evidenceId));
  const sourceTypes = [
    ...new Set(brief.sourceEvidence.evidence.map((entry) => entry.sourceType))
  ].sort();

  // 1. Content the brief cites as evidence must not be silently dropped from the section that
  //    exists to present it. A contact record reaching Source Evidence while the person it names
  //    is missing from the Stakeholder Map means the reviewer is looking at a hole, not a gap.
  for (const [evidenceId, contactName] of Object.entries(expectations.contactsByEvidenceId)) {
    if (!citedEvidenceIds.has(evidenceId)) continue;
    if (normalizedNames.some((name) => name === normalize(contactName))) continue;
    violations.push({
      rule: 'silently-discarded-stakeholder',
      detail: `Source Evidence cites ${evidenceId} but the Stakeholder Map omits ${contactName}. Present: ${stakeholderNames.join(', ') || 'none'}.`
    });
  }

  // 2. The validator's own discard markers are internal bookkeeping. Their presence proves content
  //    was deleted after generation, which is exactly the state a delivered brief must not be in.
  for (const gap of brief.stakeholderMap.coverageGaps ?? [])
    if (/^verify unsupported stakeholder records\.?$/iu.test(gap.trim()))
      violations.push({
        rule: 'discarded-content-marker',
        detail: `stakeholderMap.coverageGaps carries the post-validation discard marker "${gap}".`
      });
  for (const item of brief.missingInformation.items)
    if (/^verify unsupported generated assertions before use\.?$/iu.test(item.question.trim()))
      violations.push({
        rule: 'discarded-content-marker',
        detail: `missingInformation carries the post-validation discard marker "${item.question}".`
      });

  // 3. A brief citing one source family is a CRM dump. The deliverable promises the reviewer that
  //    Slack account-team updates and Gong conversations reach Source Evidence.
  if (sourceTypes.length < expectations.minimumSourceTypes)
    violations.push({
      rule: 'multi-source-citations',
      detail: `Source Evidence cites ${sourceTypes.length} source type(s) (${sourceTypes.join(', ') || 'none'}); at least ${expectations.minimumSourceTypes} are required.`
    });
  for (const required of expectations.reachableSourceTypes)
    if (!sourceTypes.includes(required as (typeof sourceTypes)[number]))
      violations.push({
        rule: 'multi-source-citations',
        detail: `Source Evidence cites no "${required}" evidence although the authorized manifest reaches it. Cited: ${sourceTypes.join(', ') || 'none'}.`
      });

  // 4. A section rendered with a heading and nothing under it is the failure shape the production
  //    run produced: zero stakeholders, zero actions, zero risks, zero evidence.
  const sections: Record<string, number> = {
    stakeholderMap: brief.stakeholderMap.stakeholders.length,
    recommendedNextActions: brief.recommendedNextActions.actions.length,
    negotiationRisks: brief.negotiationState.risks.length,
    sourceEvidence: brief.sourceEvidence.evidence.length
  };
  for (const [section, count] of Object.entries(sections))
    if (count === 0)
      violations.push({
        rule: 'required-sections-populated',
        detail: `${section} is empty in a finalized brief for an authorized deal with available evidence.`
      });

  // 5. Internal identifiers are meaningless to the reviewer and leak run internals into copy.
  for (const field of collectUserFacingProse(brief))
    for (const { label, pattern } of INTERNAL_IDENTIFIER_PATTERNS) {
      const match = pattern.exec(field.text);
      if (match !== null)
        violations.push({
          rule: 'internal-identifier-in-copy',
          detail: `${field.path} exposes an internal ${label} ("${match[0]}") in user-facing copy: "${field.text}".`
        });
    }

  // 6. A brief must not present a stakeholder as supported and then warn that the same person is
  //    absent. Whichever half is wrong, the reviewer cannot act on a document that contradicts
  //    itself.
  const supported = supportedStakeholderNames(brief);
  for (const warning of brief.confidenceAndReviewWarnings.warnings) {
    if (!ABSENCE_WORDING.test(warning.message)) continue;
    const message = normalize(warning.message);
    for (const name of supported)
      if (containsPhrase(message, normalize(name)))
        violations.push({
          rule: 'self-contradictory-warning',
          detail: `Warning ${warning.code} reports "${warning.message}" while the brief presents ${name} as a cited, supported stakeholder.`
        });
  }

  return { violations, sourceTypes, stakeholderNames, sections };
}

/** Groups a report's violations by rule so a CI failure reads as a checklist. */
export function summarizeViolations(
  violations: readonly BriefQualityViolation[]
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const violation of violations) counts[violation.rule] = (counts[violation.rule] ?? 0) + 1;
  return counts;
}

/**
 * Derives what a deal's authorized fixtures make reachable, so no expectation is hand-maintained.
 *
 * The contact-to-evidence-id mapping mirrors the chunk id `buildEvidenceDocuments` assigns to a
 * contact row, which is the same identifier a finalized brief cites.
 */
export function expectationsForOpportunity(
  root: string,
  opportunityId: string
): BriefQualityExpectations {
  const fixtures = parseFixtureSet(root);
  const opportunity = fixtures.opportunities.find((entry) => entry.opportunityId === opportunityId);
  if (opportunity === undefined) throw new Error(`Unknown opportunity fixture: ${opportunityId}`);
  const contactsByEvidenceId: Record<string, string> = {};
  for (const contact of fixtures.contacts)
    if (contact.accountId === opportunity.accountId)
      contactsByEvidenceId[`salesforce:${contact.contactId}:${opportunityId}:contact:0`] =
        contact.fullName;
  const reachableSourceTypes = [
    ...new Set([
      'crm',
      ...(fixtures.gongSummaries.some((call) => call.opportunityId === opportunityId)
        ? ['conversation']
        : []),
      ...(fixtures.slackUpdates.some((update) => update.opportunityId === opportunityId)
        ? ['slack']
        : [])
    ])
  ];
  return { contactsByEvidenceId, reachableSourceTypes, minimumSourceTypes: 2 };
}

const SAMPLE_TARGETS: readonly Readonly<{ file: string; opportunityId: string }>[] = [
  { file: 'samples/normal-opportunity-brief.json', opportunityId: 'OPP-1001' },
  { file: 'samples/restricted-opportunity-brief.json', opportunityId: 'OPP-1003' }
];

/** Audits every checked-in sample brief and reports each quality invariant it violates. */
async function main(): Promise<void> {
  let failed = 0;
  for (const target of SAMPLE_TARGETS) {
    const raw: unknown = JSON.parse(await readFile(resolve(target.file), 'utf8'));
    const report = evaluateBriefQuality(
      raw,
      expectationsForOpportunity(resolve('fixtures/cato'), target.opportunityId)
    );
    process.stdout.write(`\n${target.file}\n`);
    process.stdout.write(
      `  source types: ${report.sourceTypes.join(', ') || 'none'}\n` +
        `  stakeholders: ${report.stakeholderNames.join(', ') || 'none'}\n` +
        `  section sizes: ${JSON.stringify(report.sections)}\n`
    );
    if (report.violations.length === 0) {
      process.stdout.write('  PASS - no brief-quality violations\n');
      continue;
    }
    failed += report.violations.length;
    process.stdout.write(`  FAIL - ${report.violations.length} violation(s)\n`);
    for (const violation of report.violations)
      process.stdout.write(`    [${violation.rule}] ${violation.detail}\n`);
  }
  process.stdout.write(`\nTotal brief-quality violations: ${failed}\n`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
