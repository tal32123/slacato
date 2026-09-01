import type { DealWorkspaceView } from '@slacato/contracts';
import { Button } from '@/components/ui/button';
import { formatDealAmount } from '@/features/deals/deal-format';

type EvidenceRecord = DealWorkspaceView['evidence'][number];

/** Presents only source-backed deal facts and authorized source availability before generation. */
export function DealOverview({
  workspace
}: Readonly<{ workspace: DealWorkspaceView }>): React.JSX.Element {
  const { deal, generatedOutput } = workspace;
  const sourceCounts = countSources(workspace.evidence);

  return (
    <section className="border-b py-8" aria-labelledby="deal-overview-heading">
      <div className="flex flex-col gap-8">
        <div>
          <h2 id="deal-overview-heading" className="text-2xl font-semibold">
            {generatedOutput === null ? 'No AI brief yet' : 'AI brief is ready'}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            {generatedOutput === null
              ? 'Review the authorized deal facts and available input types before generating a brief.'
              : 'Review the generation metadata and AI-generated preview before opening the full brief.'}
          </p>
        </div>

        <section aria-labelledby="deal-facts-heading">
          <h3 id="deal-facts-heading" className="text-lg font-semibold">
            Deal facts
          </h3>
          <dl className="mt-4 grid gap-x-8 gap-y-4 rounded-lg border bg-card p-5 sm:grid-cols-2 xl:grid-cols-3">
            <Fact label="Opportunity ID" value={deal.opportunityId} />
            <Fact label="Opportunity" value={deal.opportunityName} />
            <Fact label="Account" value={deal.accountName} />
            <Fact label="Stage" value={deal.stage} />
            <Fact label="Owner" value={deal.owner ?? 'Not recorded'} />
            <Fact label="Close date" value={deal.closeDate ?? 'Not recorded'} />
            <Fact label="Amount" value={formatDealAmount(deal)} />
            <Fact
              label="Probability"
              value={deal.probability === null ? 'Not recorded' : `${deal.probability}%`}
            />
            <Fact label="Risk" value={title(deal.riskLevel)} />
            <Fact
              label="Access"
              value={deal.restricted ? 'Restricted — authorized' : 'Authorized'}
            />
            <Fact label="Created" value={deal.createdAt} />
            <Fact
              label="Latest run"
              value={
                deal.latestRun === null
                  ? 'No run yet'
                  : `${title(deal.latestRun.status.replaceAll('_', ' '))} · ${deal.latestRun.updatedAt}`
              }
            />
          </dl>
        </section>

        {generatedOutput === null ? (
          <section aria-labelledby="authorized-inputs-heading">
            <h3 id="authorized-inputs-heading" className="text-lg font-semibold">
              Authorized inputs available
            </h3>
            {sourceCounts.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No authorized source types are available.
              </p>
            ) : (
              <ul className="mt-4 flex flex-wrap gap-2" aria-label="Authorized source types">
                {sourceCounts.map(([sourceType, count]) => (
                  <li
                    key={sourceType}
                    className="rounded-full border bg-muted/40 px-3 py-1.5 text-sm"
                  >
                    {sourceTypeLabel(sourceType)} · {count} {count === 1 ? 'record' : 'records'}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <GeneratedOverview workspace={workspace} />
        )}
      </div>
    </section>
  );
}

/** Summarizes generation state without reproducing the full generated brief. */
function GeneratedOverview({
  workspace
}: Readonly<{ workspace: DealWorkspaceView }>): React.JSX.Element | null {
  const generatedOutput = workspace.generatedOutput;
  if (generatedOutput === null) return null;
  const preview = generatedOutput.content.sections.executiveSummary;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
      <section
        className="rounded-lg border border-primary/20 bg-primary/5 p-5"
        aria-labelledby="ai-preview-heading"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">
          AI-generated content
        </p>
        <h3 id="ai-preview-heading" className="mt-2 text-lg font-semibold">
          AI-generated preview
        </h3>
        <div className="mt-3 grid gap-2 text-sm leading-6">
          {preview.paragraphs.slice(0, 2).map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {preview.items.length > 0 && (
            <ul className="grid gap-1 pl-5 marker:text-primary">
              {preview.items.slice(0, 3).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {preview.paragraphs.length === 0 && preview.items.length === 0 && (
            <p className="text-muted-foreground">The generated executive summary is empty.</p>
          )}
        </div>
      </section>

      <section aria-labelledby="generation-details-heading">
        <h3 id="generation-details-heading" className="text-lg font-semibold">
          Generation details
        </h3>
        <dl className="mt-4 grid gap-4 rounded-lg border bg-card p-5">
          <Fact label="Lifecycle" value={title(generatedOutput.lifecycle)} />
          <Fact label="Run ID" value={generatedOutput.producingRun.id} />
          <Fact
            label="Run status"
            value={title(generatedOutput.producingRun.status.replaceAll('_', ' '))}
          />
          <Fact label="Updated" value={generatedOutput.producingRun.updatedAt} />
        </dl>
      </section>
    </div>
  );
}

const provenance = [
  {
    name: 'Conversation Intelligence',
    responsibility:
      'Finds buyer goals, concerns, commitments, objections, and missing context in authorized conversation evidence.'
  },
  {
    name: 'Stakeholder Intelligence',
    responsibility:
      'Builds the stakeholder map, influence assessment, relationship state, and coverage gaps.'
  },
  {
    name: 'Commercial Policy Analysis',
    responsibility:
      'Analyzes authorized commercial terms, pricing, policy triggers, and required approvals.'
  },
  {
    name: 'Negotiation Strategy',
    responsibility:
      'Synthesizes validated specialist findings into negotiation state, prioritized actions, warnings, and the final brief.'
  }
] as const;

/** Names the implemented specialist responsibilities behind a generated brief. */
export function AiProvenance(): React.JSX.Element {
  return (
    <section className="border-b py-8" aria-labelledby="ai-provenance-heading">
      <h2 id="ai-provenance-heading" className="text-2xl font-semibold">
        AI provenance
      </h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
        The generated brief combines four bounded AI responsibilities. Authorization, retrieval,
        citation validation, and policy enforcement remain deterministic application behavior.
      </p>
      <ul className="mt-5 grid gap-3 md:grid-cols-2" aria-label="AI brief provenance">
        {provenance.map((entry) => (
          <li key={entry.name} className="rounded-lg border bg-card p-4">
            <h3 className="font-semibold">{entry.name}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{entry.responsibility}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Groups raw authorized records by their source type and opens the selected record on request. */
export function SourceRecords({
  records,
  selectedEvidenceId,
  onEvidence
}: Readonly<{
  records: DealWorkspaceView['evidence'];
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
}>): React.JSX.Element {
  const groups = groupSources(records);

  return (
    <section className="border-b py-8" aria-labelledby="authorized-source-records-heading">
      <h2 id="authorized-source-records-heading" className="text-2xl font-semibold">
        Authorized source records
      </h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
        Raw records currently authorized for this deal workspace, grouped by source type.
      </p>
      {groups.length === 0 ? (
        <p className="mt-5 rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          No authorized source records are available.
        </p>
      ) : (
        <div className="mt-6 grid gap-8">
          {groups.map(([sourceType, sourceRecords]) => (
            <section
              key={sourceType}
              className="min-w-0"
              aria-labelledby={`source-records-${sourceType}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 id={`source-records-${sourceType}`} className="text-lg font-semibold">
                  {sourceTypeLabel(sourceType)}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {sourceRecords.length} {sourceRecords.length === 1 ? 'record' : 'records'}
                </p>
              </div>
              <ul className="mt-3 grid min-w-0 gap-3">
                {sourceRecords.map((record) => {
                  const selected = selectedEvidenceId === record.id;
                  return (
                    <li key={record.id} className="min-w-0">
                      <article className="min-w-0 rounded-lg border bg-card p-4">
                        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                          <div className="min-w-0">
                            <h4 className="break-words font-medium">{record.citationLabel}</h4>
                            <p className="mt-1 break-words text-xs text-muted-foreground">
                              {record.sourcePath} · {record.stableKey}={record.stableId} · captured{' '}
                              {record.capturedAt}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant={selected ? 'default' : 'outline'}
                            aria-label={`Open source record: ${record.citationLabel}`}
                            aria-pressed={selected}
                            onClick={(event) => onEvidence(record.id, event.currentTarget)}
                          >
                            Open source record
                          </Button>
                        </div>
                        <pre className="mt-4 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs leading-5">
                          {record.content}
                        </pre>
                      </article>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 break-words text-sm font-medium">{value}</dd>
    </div>
  );
}

function countSources(
  records: readonly EvidenceRecord[]
): [EvidenceRecord['sourceType'], number][] {
  return groupSources(records).map(([sourceType, groupedRecords]) => [
    sourceType,
    groupedRecords.length
  ]);
}

function groupSources(
  records: readonly EvidenceRecord[]
): [EvidenceRecord['sourceType'], EvidenceRecord[]][] {
  const groups = new Map<EvidenceRecord['sourceType'], EvidenceRecord[]>();
  for (const record of records) {
    const group = groups.get(record.sourceType);
    if (group === undefined) groups.set(record.sourceType, [record]);
    else group.push(record);
  }
  return [...groups.entries()].sort(([first], [second]) => first.localeCompare(second));
}

function sourceTypeLabel(sourceType: EvidenceRecord['sourceType']): string {
  return title(sourceType.replaceAll('_', ' '));
}

function title(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
