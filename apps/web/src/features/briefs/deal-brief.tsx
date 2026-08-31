import type {
  DealBriefView,
  DealWorkspaceView,
  RecommendedActionView,
  StakeholderView
} from '@slacato/contracts';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  CircleDollarSign,
  Gauge,
  UserRound
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { formatDealAmount } from '@/features/deals/deal-format';
import { cn } from '@/lib/utils';

const sectionOrder = [
  'dealSnapshot',
  'executiveSummary',
  'buyerGoalsAndBusinessDrivers',
  'stakeholderMap',
  'negotiationState',
  'recommendedNextActions',
  'missingInformation',
  'sourceEvidence',
  'confidenceAndReviewWarnings'
] as const;

type EvidenceIndex = ReadonlyMap<string, DealWorkspaceView['evidence'][number]>;

/** Maps an authorized evidence id to the footnote number it carries everywhere on this page. */
type CitationNumbering = ReadonlyMap<string, number>;

/**
 * Lists the evidence ids a brief cites, in the order the page renders them.
 *
 * Stakeholder, action, and warning citations come before their section's own citation row because
 * that is where they sit in the DOM, so reading the page top to bottom meets the numbers in
 * ascending order.
 */
function briefCitationOrder(brief: DealBriefView): string[] {
  return sectionOrder.flatMap((id) => [
    ...(id === 'stakeholderMap'
      ? brief.stakeholders.flatMap((stakeholder) => stakeholder.citationIds)
      : []),
    ...(id === 'recommendedNextActions'
      ? brief.actions.flatMap((action) => action.citationIds)
      : []),
    ...(id === 'confidenceAndReviewWarnings'
      ? brief.warnings.flatMap((warning) => warning.citationIds)
      : []),
    ...brief.sections[id].citationIds
  ]);
}

/**
 * Gives every cited record one number that means the same source everywhere on the page.
 *
 * Citations used to be rendered as their full label next to each claim, which buried the prose
 * under a wall of near-identical chips. A footnote number only works if `[3]` is the same record
 * in the generated brief, in the deterministic snapshot, and in the reference list, so the number
 * is assigned once here in first-citation order over the briefs actually rendered — never from the
 * deprecated `workspace.brief` alias, which would walk one of them twice.
 */
function buildCitationNumbering(
  briefs: readonly DealBriefView[],
  evidence: EvidenceIndex
): CitationNumbering {
  const numbering = new Map<string, number>();
  for (const citationId of briefs.flatMap(briefCitationOrder)) {
    if (numbering.has(citationId) || !evidence.has(citationId)) continue;
    numbering.set(citationId, numbering.size + 1);
  }
  return numbering;
}

/** Resolves cited ids to the authorized evidence records still readable by this requester. */
function resolveCitations(
  citationIds: readonly string[],
  evidence: EvidenceIndex
): DealWorkspaceView['evidence'][number][] {
  return citationIds
    .map((id) => evidence.get(id))
    .filter((item): item is DealWorkspaceView['evidence'][number] => item !== undefined);
}

/** Presents the source-backed deal brief, metrics, recommendations, and linked evidence to the seller. */
export function DealBrief({
  workspace,
  selectedEvidenceId,
  onEvidence,
  primaryAction
}: Readonly<{
  workspace: DealWorkspaceView;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
  primaryAction: ReactNode;
}>): React.JSX.Element {
  const { deal, sourceSnapshot, generatedOutput } = workspace;
  const evidence = new Map(workspace.evidence.map((item) => [item.id, item]));
  const numbering = buildCitationNumbering(
    generatedOutput === null
      ? [sourceSnapshot.evidenceOverview]
      : [generatedOutput.content, sourceSnapshot.evidenceOverview],
    evidence
  );
  return (
    <article data-deal-main className="min-w-0">
      <Button asChild variant="link" className="min-h-11 px-0">
        <Link to="/deals">
          <ArrowLeft aria-hidden="true" />
          Back to authorized deals
        </Link>
      </Button>
      <header className="mt-3 border-b pb-7">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                status={deal.restricted ? 'attention' : 'ready'}
                label={deal.restricted ? 'Restricted — authorized' : 'Authorized workspace'}
              />
              <StatusBadge status="readonly" label="Source snapshot" />
            </div>
            <p className="mt-4 text-sm font-medium text-primary">{deal.opportunityId}</p>
            <h1 className="mt-1 max-w-4xl text-3xl font-semibold tracking-tight sm:text-4xl">
              {deal.opportunityName}
            </h1>
            <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">
              Authorized deal evidence for {deal.accountName}. Generated output, when available,
              remains separate and requires seller judgment.
            </p>
          </div>
          {primaryAction}
        </div>
      </header>

      <section
        className="grid gap-3 border-b py-6 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Deal metrics"
      >
        <Metric
          icon={CircleDollarSign}
          label="Annual contract value"
          value={formatDealAmount(deal)}
        />
        <Metric icon={CalendarDays} label="Close date" value={deal.closeDate ?? 'Not recorded'} />
        <Metric
          icon={Gauge}
          label="Stage and risk"
          value={`${deal.stage} · ${title(deal.riskLevel)} risk`}
        />
        <Metric
          icon={UserRound}
          label="Owner and latest run"
          value={`${deal.owner ?? 'Owner not recorded'} · ${deal.latestRun === null ? 'No run yet' : deal.latestRun.status.replaceAll('_', ' ')}`}
        />
      </section>

      {generatedOutput === null ? (
        <section className="border-b py-8" aria-labelledby="source-snapshot">
          <h2 id="source-snapshot" className="text-2xl font-semibold">
            {sourceSnapshot.label}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Evidence overview assembled deterministically from currently authorized, ingested
            records. It is not AI-generated and is not produced by a run.
          </p>
          <WorkspaceContent
            brief={sourceSnapshot.evidenceOverview}
            evidence={evidence}
            numbering={numbering}
            selectedEvidenceId={selectedEvidenceId}
            onEvidence={onEvidence}
            sourceCues
            carriesTourAnchor
          />
        </section>
      ) : (
        <>
          <section className="border-b py-8" aria-labelledby="generated-output">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="generated-output" className="text-2xl font-semibold">
                {generatedOutput.lifecycle === 'finalized'
                  ? 'Finalized generated output'
                  : 'Generated draft'}
              </h2>
              <StatusBadge
                status="readonly"
                label={generatedOutput.lifecycle === 'finalized' ? 'Finalized' : 'Draft'}
              />
            </div>
            <p className="mt-3 break-words text-sm leading-6 text-muted-foreground">
              This is the primary brief for this negotiation. Produced by run{' '}
              {generatedOutput.producingRun.id} ·{' '}
              {generatedOutput.producingRun.status.replaceAll('_', ' ')}
            </p>
            <WorkspaceContent
              brief={generatedOutput.content}
              evidence={evidence}
              numbering={numbering}
              selectedEvidenceId={selectedEvidenceId}
              onEvidence={onEvidence}
              carriesTourAnchor
            />
          </section>

          <section className="border-b py-8">
            <details className="group" data-testid="source-snapshot-disclosure">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 py-1 [&::-webkit-details-marker]:hidden">
                <span className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
                  <h2 className="text-2xl font-semibold">{sourceSnapshot.label}</h2>
                  <StatusBadge status="readonly" label="Deterministic — not AI-generated" />
                </span>
                <span className="text-sm font-medium text-primary underline underline-offset-4 group-open:hidden">
                  Show reference view
                </span>
                <span className="hidden text-sm font-medium text-primary underline underline-offset-4 group-open:inline">
                  Hide reference view
                </span>
              </summary>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                Evidence overview assembled deterministically from currently authorized, ingested
                records. It is not AI-generated and is not produced by a run. Kept as a
                citation-backed reference alongside the generated brief above.
              </p>
              <WorkspaceContent
                brief={sourceSnapshot.evidenceOverview}
                evidence={evidence}
                numbering={numbering}
                selectedEvidenceId={selectedEvidenceId}
                onEvidence={onEvidence}
                sourceCues
                qualifyHeadings
              />
            </details>
          </section>
        </>
      )}
    </article>
  );
}

/** Renders brief workspace sections with numbered evidence citation markers. */
function WorkspaceContent({
  brief,
  evidence,
  numbering,
  selectedEvidenceId,
  onEvidence,
  sourceCues = false,
  qualifyHeadings = false,
  carriesTourAnchor = false
}: Readonly<{
  brief: DealWorkspaceView['brief'];
  evidence: EvidenceIndex;
  /** Page-wide footnote numbers, so the same record reads as the same `[n]` in every section. */
  numbering: CitationNumbering;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
  sourceCues?: boolean;
  /** Distinguishes these headings from an identically titled generated brief on the same page.
   *  Only meaningful when both views render together; alone it just corrupts the accessible name. */
  qualifyHeadings?: boolean;
  /**
   * Marks this as the brief a guided-tour step means when it names a section.
   *
   * Set on exactly one view per page: the generated brief when there is one, the deterministic
   * snapshot when it is the only brief rendered. Both views emit the same nine section ids, so
   * without this the tour's Source Evidence anchor matched twice and resolved by DOM order --
   * always to the generated brief, even while the step's copy described the other one, which sits
   * thousands of pixels lower inside a closed disclosure. Anchoring only the view a reader is
   * actually looking at makes the step frame something real in both states.
   */
  carriesTourAnchor?: boolean;
}>): React.JSX.Element {
  return (
    <div>
      {sectionOrder.map((id) => {
        const section = brief.sections[id];
        const isSourceCue =
          sourceCues && (id === 'recommendedNextActions' || id === 'confidenceAndReviewWarnings');
        return (
          <section
            key={id}
            data-tour={
              id === 'sourceEvidence'
                ? carriesTourAnchor
                  ? 'slack-evidence'
                  : 'snapshot-source-evidence'
                : undefined
            }
            className="border-b py-8"
            aria-labelledby={`${brief.status}-${id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 id={`${brief.status}-${id}`} className="text-xl font-semibold">
                {section.title}
                {qualifyHeadings && ' '}
                {qualifyHeadings && (
                  <span className="ml-2 align-middle text-xs font-normal uppercase tracking-wide text-muted-foreground">
                    Source snapshot
                  </span>
                )}
              </h3>
              <div className="flex flex-wrap gap-2">
                {isSourceCue && <StatusBadge status="readonly" label="Deterministic source cue" />}
                {section.accountTeamUpdateImpact && (
                  <StatusBadge status="attention" label="Account-team update impact" />
                )}
              </div>
            </div>
            {section.accountTeamUpdateImpact && (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {describeAccountTeamUpdateImpact(
                  accountTeamUpdateIds(section.citationIds, evidence)
                )}
              </p>
            )}
            <div className="mt-4 grid gap-3 text-sm leading-6 sm:text-base">
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
            {isEmptySection(section, id) && (
              <p className="mt-4 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                {sourceCues
                  ? 'No authorized records populate this section.'
                  : 'This section is empty. The generated output carried nothing here, so treat it as unanswered rather than as nothing to review.'}
              </p>
            )}
            {section.items.length > 0 && (
              <ul className="mt-4 grid gap-2 pl-5 text-sm leading-6 marker:text-primary sm:text-base">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {id === 'stakeholderMap' && (
              <Stakeholders
                stakeholders={brief.stakeholders}
                evidence={evidence}
                numbering={numbering}
                selectedEvidenceId={selectedEvidenceId}
                onEvidence={onEvidence}
              />
            )}
            {id === 'recommendedNextActions' && (
              <Actions
                actions={brief.actions}
                evidence={evidence}
                numbering={numbering}
                selectedEvidenceId={selectedEvidenceId}
                onEvidence={onEvidence}
                sourceCues={sourceCues}
              />
            )}
            {id === 'confidenceAndReviewWarnings' && (
              <Warnings
                warnings={brief.warnings}
                evidence={evidence}
                numbering={numbering}
                selectedEvidenceId={selectedEvidenceId}
                onEvidence={onEvidence}
              />
            )}
            {id === 'sourceEvidence' && (
              <CitationReferenceList
                citationIds={briefCitationOrder(brief)}
                numbering={numbering}
                evidence={evidence}
                selectedEvidenceId={selectedEvidenceId}
                onEvidence={onEvidence}
              />
            )}
            {/* Source Evidence closes with the numbered reference list above, which is the same
                citations spelled out in full; repeating them as bare markers says nothing more. */}
            {id !== 'sourceEvidence' && (
              <SectionCitations
                citationIds={section.citationIds}
                evidence={evidence}
                numbering={numbering}
                selectedEvidenceId={selectedEvidenceId}
                onEvidence={onEvidence}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Names the authorized account-team updates behind a set of citations, in the order they are cited. */
function accountTeamUpdateIds(citationIds: readonly string[], evidence: EvidenceIndex): string[] {
  return citationIds
    .map((citationId) => evidence.get(citationId))
    .filter((item) => item?.sourceType === 'slack')
    .map((item) => item?.stableId ?? '')
    .filter((stableId) => stableId.length > 0);
}

/**
 * Explains the "Account-team update impact" badge in place.
 *
 * The badge answers "did the generated Slack-style chatter move this?" but not "which chatter?",
 * which is the only form a reviewer can check. Naming the cited update ids turns the badge into a
 * claim the reader can verify against the evidence list a few lines below.
 */
function describeAccountTeamUpdateImpact(updateIds: readonly string[]): string {
  if (updateIds.length === 0)
    return 'Badged because this section cites a generated account-team update the requester is authorized to read.';
  const single = updateIds.length === 1;
  const label = single ? 'account-team update' : 'account-team updates';
  const consequence = single ? 'that citation is' : 'those citations are';
  return `Badged because this section cites ${label} ${updateIds.join(', ')}. Without the requester's Slack grant ${consequence} never retrieved and the badge is absent.`;
}

/** Appends the cited update ids to an inline impact label, or nothing when none are resolvable. */
function citedUpdateSuffix(citationIds: readonly string[], evidence: EvidenceIndex): string {
  const updateIds = accountTeamUpdateIds(citationIds, evidence);
  return updateIds.length === 0 ? '' : ` \u00b7 ${updateIds.join(', ')}`;
}

/**
 * Reports whether a section would render as a bare heading with nothing beneath it.
 *
 * The stakeholder and next-action sections carry their own empty states, and every other section
 * that always emits a paragraph is unaffected. This covers the rest, so an empty section reads as
 * a gap the reviewer must chase rather than as blank space they can skip.
 */
function isEmptySection(
  section: DealWorkspaceView['brief']['sections'][keyof DealWorkspaceView['brief']['sections']],
  id: (typeof sectionOrder)[number]
): boolean {
  if (id === 'stakeholderMap' || id === 'recommendedNextActions') return false;
  return section.paragraphs.length === 0 && section.items.length === 0;
}

/** Shows one labeled deal metric in the brief summary. */
function Metric({
  icon: Icon,
  label,
  value
}: Readonly<{ icon: typeof Gauge; label: string; value: string }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-lg border bg-card p-4">
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 break-words text-sm font-semibold">{value}</p>
      </div>
    </div>
  );
}

/**
 * Opens one cited record from a compact numbered marker.
 *
 * The number is only a handle: the accessible name and the hover title still carry the full,
 * verbatim `citationLabel`, which is the one citation format this product shows, and the label
 * itself is spelled out in the Source Evidence reference list every marker points at.
 */
function CitationMarker({
  citation,
  number,
  selectedEvidenceId,
  onEvidence
}: Readonly<{
  citation: DealWorkspaceView['evidence'][number];
  number: number | undefined;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
}>): React.JSX.Element {
  const selected = selectedEvidenceId === citation.id;
  return (
    <Button
      type="button"
      size="xs"
      variant={selected ? 'default' : 'outline'}
      className="h-7 min-w-9 px-1.5 font-medium tabular-nums"
      title={citation.citationLabel}
      aria-label={`Open evidence: ${citation.citationLabel}`}
      aria-pressed={selected}
      onClick={(event) => onEvidence(citation.id, event.currentTarget)}
    >
      {`[${number ?? '?'}]`}
    </Button>
  );
}

/** Renders the numbered markers that tie one piece of content back to the records behind it. */
function CitationMarkers({
  citationIds,
  evidence,
  numbering,
  selectedEvidenceId,
  onEvidence,
  label,
  className
}: Readonly<{
  citationIds: readonly string[];
  evidence: EvidenceIndex;
  numbering: CitationNumbering;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
  /** Names what these citations support, so a bare `[3]` is never the whole accessible context. */
  label: string;
  className?: string;
}>): React.JSX.Element | null {
  // Ascending order, so a row of footnotes reads as a range rather than as the arbitrary order the
  // generator happened to attach them in.
  const citations = resolveCitations(citationIds, evidence).sort(
    (first, second) => (numbering.get(first.id) ?? 0) - (numbering.get(second.id) ?? 0)
  );
  if (citations.length === 0) return null;
  return (
    <ul className={cn('flex flex-wrap items-center gap-1', className)} aria-label={label}>
      {citations.map((citation) => (
        <li key={citation.id}>
          <CitationMarker
            citation={citation}
            number={numbering.get(citation.id)}
            selectedEvidenceId={selectedEvidenceId}
            onEvidence={onEvidence}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Closes a section with the numbered sources behind it.
 *
 * This row replaced a wrapping wall of full-label buttons that pushed the prose off the screen and
 * repeated the same long strings in every section. It keeps the guided tour's `citations` anchor,
 * now framing a labeled row rather than an unexplained pile of chips.
 */
function SectionCitations({
  citationIds,
  evidence,
  numbering,
  selectedEvidenceId,
  onEvidence
}: Readonly<{
  citationIds: readonly string[];
  evidence: EvidenceIndex;
  numbering: CitationNumbering;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
}>): React.JSX.Element | null {
  if (resolveCitations(citationIds, evidence).length === 0) return null;
  return (
    <div
      data-tour="citations"
      className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Sources
      </span>
      <CitationMarkers
        citationIds={citationIds}
        evidence={evidence}
        numbering={numbering}
        selectedEvidenceId={selectedEvidenceId}
        onEvidence={onEvidence}
        label="Section citations"
      />
    </div>
  );
}

/**
 * Spells out every citation this brief makes, in number order, with its full label.
 *
 * This is where the labels moved to when the markers became numbers, so Source Evidence is the
 * complete, checkable list every `[n]` in this brief resolves against. The numbers are the page's,
 * so the list can legitimately skip one the other brief on the page cites and this one does not.
 */
function CitationReferenceList({
  citationIds,
  numbering,
  evidence,
  selectedEvidenceId,
  onEvidence
}: Readonly<{
  citationIds: readonly string[];
  numbering: CitationNumbering;
  evidence: EvidenceIndex;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
}>): React.JSX.Element | null {
  const entries = [...new Set(citationIds)]
    .map((id) => ({ number: numbering.get(id), citation: evidence.get(id) }))
    .filter(
      (entry): entry is { number: number; citation: DealWorkspaceView['evidence'][number] } =>
        entry.citation !== undefined && entry.number !== undefined
    )
    .sort((first, second) => first.number - second.number);
  if (entries.length === 0) return null;
  return (
    <ol className="mt-5 grid gap-2" aria-label="Numbered source evidence">
      {entries.map(({ number, citation }) => (
        <li key={citation.id} className="flex min-w-0 items-start gap-3">
          <CitationMarker
            citation={citation}
            number={number}
            selectedEvidenceId={selectedEvidenceId}
            onEvidence={onEvidence}
          />
          <span className="min-w-0 break-words pt-1 text-sm leading-6 text-muted-foreground">
            {citation.citationLabel}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Presents authorized stakeholder details in layouts suited to desktop and mobile screens. */
function Stakeholders({
  stakeholders,
  evidence,
  numbering,
  selectedEvidenceId,
  onEvidence
}: Readonly<{
  stakeholders: readonly StakeholderView[];
  evidence: EvidenceIndex;
  numbering: CitationNumbering;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
}>): React.JSX.Element {
  if (stakeholders.length === 0)
    return (
      <p className="mt-5 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No authorized stakeholder records are available.
      </p>
    );
  return (
    <div className="mt-6">
      <div className="hidden md:block overflow-x-auto">
        <Table aria-label="Stakeholders">
          <TableCaption>Complete authorized stakeholder records.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Influence</TableHead>
              <TableHead>Relationship</TableHead>
              <TableHead>Goals</TableHead>
              <TableHead>Concerns</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stakeholders.map((stakeholder) => (
              <TableRow key={stakeholder.name}>
                <TableCell>
                  <strong>{stakeholder.name}</strong>
                  <span className="block text-xs text-muted-foreground">
                    {stakeholder.title ?? 'Title not recorded'}
                  </span>
                  <CitationMarkers
                    citationIds={stakeholder.citationIds}
                    evidence={evidence}
                    numbering={numbering}
                    selectedEvidenceId={selectedEvidenceId}
                    onEvidence={onEvidence}
                    label={`Citations for ${stakeholder.name}`}
                    className="mt-2"
                  />
                </TableCell>
                <TableCell>{stakeholder.role}</TableCell>
                <TableCell>{stakeholder.influence}</TableCell>
                <TableCell>{stakeholder.relationship}</TableCell>
                <TableCell className="max-w-xs whitespace-normal">
                  {stakeholder.goals.join(' ') || 'None recorded'}
                </TableCell>
                <TableCell className="max-w-xs whitespace-normal">
                  {stakeholder.concerns.join(' ') || 'None recorded'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="grid gap-3 md:hidden" aria-label="Stakeholders">
        {stakeholders.map((stakeholder) => (
          <li key={stakeholder.name} className="rounded-lg border p-4">
            <strong>{stakeholder.name}</strong>
            <CitationMarkers
              citationIds={stakeholder.citationIds}
              evidence={evidence}
              numbering={numbering}
              selectedEvidenceId={selectedEvidenceId}
              onEvidence={onEvidence}
              label={`Citations for ${stakeholder.name}`}
              className="mt-2"
            />
            <dl className="mt-3 grid gap-2 text-sm">
              <Fact label="Title" value={stakeholder.title ?? 'Not recorded'} />
              <Fact label="Role" value={stakeholder.role} />
              <Fact label="Influence" value={stakeholder.influence} />
              <Fact label="Relationship" value={stakeholder.relationship} />
              <Fact label="Goals" value={stakeholder.goals.join(' ') || 'None recorded'} />
              <Fact label="Concerns" value={stakeholder.concerns.join(' ') || 'None recorded'} />
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Presents source-backed recommended actions in layouts suited to desktop and mobile screens. */
function Actions({
  actions,
  evidence,
  numbering,
  selectedEvidenceId,
  onEvidence,
  sourceCues = false
}: Readonly<{
  actions: readonly RecommendedActionView[];
  evidence: EvidenceIndex;
  numbering: CitationNumbering;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
  sourceCues?: boolean;
}>): React.JSX.Element {
  if (actions.length === 0)
    return (
      <p className="mt-5 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No {sourceCues ? 'deterministic source cues' : 'generated actions'} are available.
      </p>
    );
  const caption = sourceCues
    ? 'Deterministic source cues drawn from authorized records; they are not AI-generated recommendations.'
    : 'Generated next actions; no action sends customer-facing content.';
  return (
    <div className="mt-6">
      <div className="hidden md:block">
        <Table aria-label="Recommended actions">
          <TableCaption>{caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Rationale</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {actions.map((action) => (
              <TableRow key={action.action}>
                <TableCell className="font-medium">
                  {action.action}
                  {action.accountTeamUpdateImpact && (
                    <span className="mt-1 block text-xs font-medium text-attention-foreground">
                      Account-team update impact{citedUpdateSuffix(action.citationIds, evidence)}
                    </span>
                  )}
                  <CitationMarkers
                    citationIds={action.citationIds}
                    evidence={evidence}
                    numbering={numbering}
                    selectedEvidenceId={selectedEvidenceId}
                    onEvidence={onEvidence}
                    label="Action citations"
                    className="mt-2"
                  />
                </TableCell>
                <TableCell>{action.owner ?? 'Not assigned'}</TableCell>
                <TableCell>{action.priority}</TableCell>
                <TableCell>{action.dueDate ?? 'Not recorded'}</TableCell>
                <TableCell className="max-w-sm">{action.rationale}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="grid gap-3 md:hidden" aria-label="Recommended actions">
        {actions.map((action) => (
          <li key={action.action} className="rounded-lg border p-4">
            <strong>{action.action}</strong>
            {action.accountTeamUpdateImpact && (
              <p className="mt-2 text-xs font-semibold text-attention-foreground">
                Account-team update impact{citedUpdateSuffix(action.citationIds, evidence)}
              </p>
            )}
            <CitationMarkers
              citationIds={action.citationIds}
              evidence={evidence}
              numbering={numbering}
              selectedEvidenceId={selectedEvidenceId}
              onEvidence={onEvidence}
              label="Action citations"
              className="mt-2"
            />
            <dl className="mt-3 grid gap-2 text-sm">
              <Fact label="Owner" value={action.owner ?? 'Not assigned'} />
              <Fact label="Priority" value={action.priority} />
              <Fact label="Due" value={action.dueDate ?? 'Not recorded'} />
              <Fact label="Rationale" value={action.rationale} />
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Highlights confidence and review warnings attached to the brief. */
function Warnings({
  warnings,
  evidence,
  numbering,
  selectedEvidenceId,
  onEvidence
}: Readonly<{
  warnings: DealWorkspaceView['brief']['warnings'];
  evidence: EvidenceIndex;
  numbering: CitationNumbering;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
}>): React.JSX.Element | null {
  if (warnings.length === 0) return null;
  return (
    <ul className="mt-5 grid gap-3">
      {warnings.map((warning) => (
        <li
          key={warning.message}
          className="flex items-start gap-3 rounded-lg border border-attention bg-attention/10 p-4 text-sm"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-attention-foreground"
          />
          <div>
            <strong className="capitalize">{warning.severity}</strong>
            <p className="mt-1 leading-6">{warning.message}</p>
            {warning.accountTeamUpdateImpact && (
              <p className="mt-2 text-xs font-semibold text-attention-foreground">
                Account-team update impact{citedUpdateSuffix(warning.citationIds, evidence)}
              </p>
            )}
            <CitationMarkers
              citationIds={warning.citationIds}
              evidence={evidence}
              numbering={numbering}
              selectedEvidenceId={selectedEvidenceId}
              onEvidence={onEvidence}
              label="Warning citations"
              className="mt-2"
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
/** Shows one labeled stakeholder fact in the mobile view. */
function Fact({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}
/** Converts a stored label into the capitalized wording shown to the seller. */
function title(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
