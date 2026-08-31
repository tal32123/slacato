import type { ApprovalBriefPayload, ApprovalCitation, ApprovalClaim } from '@slacato/contracts';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

/** Presents the validated brief under review: every section of the immutable approval subject. */
export function ApprovalSubjectDetail({
  payload,
  evidenceIds,
  opportunityId
}: Readonly<{
  payload: ApprovalBriefPayload;
  evidenceIds: ReadonlySet<string>;
  opportunityId: string;
}>): React.JSX.Element {
  const numbers = numberEvidence(payload);
  const claims = indexClaims(payload);
  return (
    <div className="mt-5 grid gap-5">
      <SubjectSection title="Deal snapshot">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <BriefFact label="Account" value={payload.dealSnapshot.accountName} />
          <BriefFact label="Opportunity" value={payload.dealSnapshot.opportunityName} />
          <BriefFact label="Stage" value={payload.dealSnapshot.stage} />
          {payload.dealSnapshot.owner && (
            <BriefFact label="Owner" value={payload.dealSnapshot.owner} />
          )}
          {payload.dealSnapshot.closeDate && (
            <BriefFact label="Close date" value={payload.dealSnapshot.closeDate} />
          )}
          {payload.dealSnapshot.amount !== undefined && (
            <BriefFact
              label="Amount"
              value={`${payload.dealSnapshot.currency ?? ''} ${payload.dealSnapshot.amount.toLocaleString()}`.trim()}
            />
          )}
        </dl>
        <ClaimList
          claims={payload.dealSnapshot.claims ?? []}
          numbers={numbers}
          evidenceIds={evidenceIds}
          empty="No deal snapshot claims were supported by the validated evidence."
        />
      </SubjectSection>
      <SubjectSection title="Executive summary">
        <p className="leading-7">{payload.executiveSummary.narrative}</p>
        <ClaimList
          claims={payload.executiveSummary.claims ?? []}
          numbers={numbers}
          evidenceIds={evidenceIds}
          empty="No executive summary claims were supported by the validated evidence."
        />
      </SubjectSection>
      <SubjectSection title="Buyer goals and business drivers">
        <BriefList
          title="Goals"
          values={payload.buyerGoalsAndBusinessDrivers.goals}
          empty="No buyer goals were supported by the validated evidence."
          claims={payload.buyerGoalsAndBusinessDrivers.claims ?? []}
          numbers={numbers}
          evidenceIds={evidenceIds}
        />
        <BriefList
          title="Business drivers"
          values={payload.buyerGoalsAndBusinessDrivers.businessDrivers}
          empty="No business drivers were supported by the validated evidence."
          claims={payload.buyerGoalsAndBusinessDrivers.claims ?? []}
          numbers={numbers}
          evidenceIds={evidenceIds}
        />
        <ClaimList
          claims={payload.buyerGoalsAndBusinessDrivers.claims ?? []}
          numbers={numbers}
          evidenceIds={evidenceIds}
          empty="No buyer goal claims were supported by the validated evidence."
          citedInPlace={[
            ...payload.buyerGoalsAndBusinessDrivers.goals,
            ...payload.buyerGoalsAndBusinessDrivers.businessDrivers
          ]}
        />
      </SubjectSection>
      <SubjectSection title="Stakeholder map">
        {payload.stakeholderMap.stakeholders.length === 0 ? (
          <EmptyState>No stakeholders were supported by the validated evidence.</EmptyState>
        ) : (
          <ul className="grid gap-3">
            {payload.stakeholderMap.stakeholders.map((stakeholder) => (
              <li key={`${stakeholder.name}:${stakeholder.role}`} className="rounded-lg border p-3">
                <p className="font-medium">{stakeholder.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {[
                    stakeholder.title,
                    stakeholder.organization,
                    label(stakeholder.role),
                    `${label(stakeholder.influence)} influence`,
                    `${label(stakeholder.relationship)} relationship`
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {stakeholder.goals.length > 0 && (
                  <p className="mt-2 text-sm">
                    <strong>Goals:</strong> {stakeholder.goals.join('; ')}
                  </p>
                )}
                {stakeholder.concerns.length > 0 && (
                  <p className="mt-1 text-sm">
                    <strong>Concerns:</strong> {stakeholder.concerns.join('; ')}
                  </p>
                )}
                <ClaimList
                  claims={stakeholder.claims}
                  numbers={numbers}
                  evidenceIds={evidenceIds}
                  empty="No claims about this stakeholder were supported by the validated evidence."
                />
              </li>
            ))}
          </ul>
        )}
        <BriefList
          title="Coverage gaps"
          values={payload.stakeholderMap.coverageGaps ?? []}
          empty="No stakeholder coverage gaps were recorded."
          claims={payload.stakeholderMap.claims ?? []}
          numbers={numbers}
          evidenceIds={evidenceIds}
        />
        <ClaimList
          claims={payload.stakeholderMap.claims ?? []}
          numbers={numbers}
          evidenceIds={evidenceIds}
          empty="No stakeholder map claims were supported by the validated evidence."
          citedInPlace={payload.stakeholderMap.coverageGaps ?? []}
        />
      </SubjectSection>
      <SubjectSection title="Negotiation state">
        <p className="leading-7">{payload.negotiationState.currentState}</p>
        <BriefList
          title="Leverage"
          values={payload.negotiationState.leverage ?? []}
          empty="No leverage was supported by the validated evidence."
          claims={payload.negotiationState.claims ?? []}
          numbers={numbers}
          evidenceIds={evidenceIds}
        />
        <BriefList
          title="Risks"
          values={payload.negotiationState.risks}
          empty="No negotiation risks were recorded."
          claims={payload.negotiationState.claims ?? []}
          numbers={numbers}
          evidenceIds={evidenceIds}
        />
        <ClaimList
          claims={payload.negotiationState.claims ?? []}
          numbers={numbers}
          evidenceIds={evidenceIds}
          empty="No negotiation state claims were supported by the validated evidence."
          citedInPlace={[
            ...(payload.negotiationState.leverage ?? []),
            ...payload.negotiationState.risks
          ]}
        />
      </SubjectSection>
      <SubjectSection title="Recommended next actions">
        {payload.recommendedNextActions.actions.length === 0 ? (
          <EmptyState>No next actions were proposed.</EmptyState>
        ) : (
          <ul className="grid gap-3">
            {payload.recommendedNextActions.actions.map((action) => (
              <li key={action.action} className="rounded-lg border p-3">
                <p className="font-medium">{action.action}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {[
                    action.owner && `Owner: ${action.owner}`,
                    `Priority: ${label(action.priority)}`,
                    action.dueDate && `Due: ${action.dueDate}`
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <p className="mt-2 text-sm">{action.rationale}</p>
                <ClaimList
                  claims={action.claims}
                  numbers={numbers}
                  evidenceIds={evidenceIds}
                  empty="No claims behind this action were supported by the validated evidence."
                />
              </li>
            ))}
          </ul>
        )}
      </SubjectSection>
      <SubjectSection title="Missing information">
        {payload.missingInformation.items.length === 0 ? (
          <EmptyState>No material information gaps were recorded.</EmptyState>
        ) : (
          <ul className="grid gap-3">
            {payload.missingInformation.items.map((item) => (
              <li key={item.question} className="rounded-lg border p-3">
                <p className="font-medium">{item.question}</p>
                <p className="mt-1 text-sm">{item.whyItMatters}</p>
                {item.owner && (
                  <p className="mt-1 text-xs text-muted-foreground">Owner: {item.owner}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </SubjectSection>
      <SubjectSection title="Authorized evidence summaries">
        <p className="text-sm text-muted-foreground">
          Attribution lives beside each claim above. This is the roll-up those numbered citations
          point into: one entry per authorized evidence version the brief cites.
        </p>
        {payload.sourceEvidence.evidence.length === 0 ? (
          <EmptyState>No evidence summaries were included.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-3">
            {payload.sourceEvidence.evidence.map((evidence, index) => (
              // Numbered from the row's own position rather than from the lookup map, so a payload
              // that ever repeated an evidence id still yields one anchor per row.
              <li
                key={evidence.evidenceId}
                id={evidenceAnchorId(index + 1)}
                className="rounded-lg border p-3 scroll-mt-24 target:border-primary"
              >
                <p>
                  <span className="mr-2 font-medium text-primary">[{index + 1}]</span>
                  {evidence.summary}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {label(evidence.sourceType)}
                  {evidence.capturedAt === undefined ? null : (
                    <>
                      {' · '}
                      <time dateTime={evidence.capturedAt}>{formatTime(evidence.capturedAt)}</time>
                    </>
                  )}
                </p>
                {evidenceIds.has(evidence.evidenceId) && (
                  <Button asChild variant="link" className="h-auto min-h-11 px-0">
                    <Link
                      to={`/deals/${encodeURIComponent(opportunityId)}?evidence=${encodeURIComponent(evidence.evidenceId)}`}
                    >
                      Open authorized evidence
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </SubjectSection>
      <SubjectSection title="Confidence and review warnings">
        <p className="text-2xl font-semibold">
          {Math.round(payload.confidenceAndReviewWarnings.overallConfidence * 100)}%{' '}
          <span className="text-sm font-normal text-muted-foreground">overall confidence</span>
        </p>
        {payload.confidenceAndReviewWarnings.warnings.length === 0 ? (
          <EmptyState>No review warnings were recorded.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-3">
            {payload.confidenceAndReviewWarnings.warnings.map((warning) => (
              <li
                key={`${warning.code}:${warning.message}`}
                className="rounded-lg border border-attention bg-attention/10 p-3"
              >
                <p className="font-medium">
                  {label(warning.severity)} · {warning.code}
                </p>
                <p className="mt-1 text-sm">{warning.message}</p>
                <WarningClaims claimIds={warning.claimIds} claims={claims} />
              </li>
            ))}
          </ul>
        )}
      </SubjectSection>
    </div>
  );
}

/** Groups a related portion of the approval subject under a clear heading. */
export function SubjectSection({
  title,
  children
}: Readonly<{ title: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <section className="rounded-xl border bg-card p-5">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Displays one labeled fact from the approval brief. */
export function BriefFact({
  label: factLabel,
  value
}: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {factLabel}
      </dt>
      <dd className="mt-1 break-words">{value}</dd>
    </div>
  );
}

/**
 * Presents a titled list from the approval brief, citing each bullet in place.
 *
 * Roughly half of a section's claims restate one of its bullets verbatim, so rendering both would
 * print the same sentence twice. Where a claim and a bullet are the same statement, the bullet is
 * the claim, and its citation markers belong on it rather than in a list underneath.
 */
export function BriefList({
  title,
  values,
  empty,
  claims = [],
  numbers,
  evidenceIds
}: Readonly<{
  title: string;
  values: readonly string[];
  empty: string;
  claims?: readonly ApprovalClaim[];
  numbers?: ReadonlyMap<string, number>;
  evidenceIds?: ReadonlySet<string>;
}>): React.JSX.Element {
  const cited = new Map(claims.map((claim) => [claim.statement, claim]));
  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium">{title}</h4>
      {values.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {values.map((value) => {
            const claim = cited.get(value);
            return (
              <li key={value}>
                {value}
                {claim !== undefined && numbers !== undefined && evidenceIds !== undefined && (
                  <>
                    {' '}
                    <CitationMarkers
                      citations={claim.citations}
                      numbers={numbers}
                      evidenceIds={evidenceIds}
                    />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Attaches the claims that support one part of the brief to that part, with their citations.
 *
 * The reviewer's question is "what backs this?", asked section by section. A pooled evidence list
 * cannot answer it, so every claim keeps its own statement, its own confidence, and footnote
 * markers pointing at the evidence entries it cites.
 */
export function ClaimList({
  claims,
  numbers,
  evidenceIds,
  empty,
  citedInPlace = []
}: Readonly<{
  claims: readonly ApprovalClaim[];
  numbers: ReadonlyMap<string, number>;
  evidenceIds: ReadonlySet<string>;
  empty: string;
  citedInPlace?: readonly string[];
}>): React.JSX.Element | null {
  // A claim whose statement is already a bullet above has been cited there; repeating it here would
  // say the same sentence twice. When that accounts for every claim the section has, the section is
  // fully attributed and needs no list at all - which is not the same as having no claims.
  const shown = claims.filter((claim) => !citedInPlace.includes(claim.statement));
  if (claims.length > 0 && shown.length === 0) return null;
  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium">Supporting claims</h4>
      {shown.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="mt-2 grid gap-2">
          {shown.map((claim) => (
            <li key={claim.id} className="text-sm leading-6">
              <span>{claim.statement}</span>{' '}
              <CitationMarkers
                citations={claim.citations}
                numbers={numbers}
                evidenceIds={evidenceIds}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {Math.round(claim.confidence * 100)}% confidence
              </p>
              <CitationRationales citations={claim.citations} numbers={numbers} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Points a claim at the numbered evidence entries that support it.
 *
 * A marker is interactive only for evidence this reviewer is authorized to open. An unauthorized
 * citation still numbers the claim honestly, but as plain text: never a dead control, and never a
 * separate cue that would describe records the reviewer cannot read.
 */
export function CitationMarkers({
  citations,
  numbers,
  evidenceIds
}: Readonly<{
  citations: readonly ApprovalCitation[];
  numbers: ReadonlyMap<string, number>;
  evidenceIds: ReadonlySet<string>;
}>): React.JSX.Element | null {
  const markers = citations
    .map((citation) => ({ citation, number: numbers.get(citation.evidenceId) }))
    .filter(
      (marker): marker is { citation: ApprovalCitation; number: number } =>
        marker.number !== undefined
    );
  if (markers.length === 0) return null;
  return (
    <ul className="inline-flex flex-wrap gap-1 align-baseline" aria-label="Claim citations">
      {markers.map(({ citation, number }) => (
        <li key={citation.id} className="inline">
          {evidenceIds.has(citation.evidenceId) ? (
            <a
              href={`#${evidenceAnchorId(number)}`}
              aria-label={`Evidence ${number}`}
              className="rounded border px-1.5 text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              [{number}]
            </a>
          ) : (
            <span className="rounded border px-1.5 text-xs font-medium text-muted-foreground">
              [{number}]
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Repeats a citation's stated reason for supporting the claim, when the brief recorded one. */
export function CitationRationales({
  citations,
  numbers
}: Readonly<{
  citations: readonly ApprovalCitation[];
  numbers: ReadonlyMap<string, number>;
}>): React.JSX.Element | null {
  const explained = citations.filter((citation) => citation.rationale !== undefined);
  if (explained.length === 0) return null;
  return (
    <ul className="mt-1 grid gap-1 text-xs text-muted-foreground" aria-label="Citation rationales">
      {explained.map((citation) => (
        <li key={citation.id}>
          <span className="font-medium">[{numbers.get(citation.evidenceId) ?? '—'}]</span>{' '}
          {citation.rationale}
        </li>
      ))}
    </ul>
  );
}

/**
 * Names the claims a review warning was raised against.
 *
 * Warnings carry claim ids rather than text, so on their own they say a section is weak without
 * saying which assertion is weak. Resolving the ids keeps the warning checkable; ids that no longer
 * resolve are dropped rather than shown raw.
 */
export function WarningClaims({
  claimIds,
  claims
}: Readonly<{
  claimIds: readonly string[];
  claims: ReadonlyMap<string, ApprovalClaim>;
}>): React.JSX.Element | null {
  const statements = claimIds
    .map((claimId) => claims.get(claimId)?.statement)
    .filter((statement): statement is string => statement !== undefined);
  if (statements.length === 0) return null;
  return (
    <p className="mt-2 text-xs text-muted-foreground">Raised against: {statements.join(' · ')}</p>
  );
}

/** Explains when an approval-brief section has no recorded content. */
export function EmptyState({
  children
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <p className="mt-2 text-sm text-muted-foreground">{children}</p>;
}

/** Numbers each evidence summary so inline claim markers can point into that one roll-up list. */
function numberEvidence(payload: ApprovalBriefPayload): ReadonlyMap<string, number> {
  return new Map(
    payload.sourceEvidence.evidence.map((evidence, index) => [evidence.evidenceId, index + 1])
  );
}

/** Indexes every claim the brief carries by id, so a warning can name what it was raised against. */
function indexClaims(payload: ApprovalBriefPayload): ReadonlyMap<string, ApprovalClaim> {
  const sections = [
    payload.dealSnapshot.claims,
    payload.executiveSummary.claims,
    payload.buyerGoalsAndBusinessDrivers.claims,
    payload.stakeholderMap.claims,
    payload.negotiationState.claims,
    ...payload.stakeholderMap.stakeholders.map((stakeholder) => stakeholder.claims),
    ...payload.recommendedNextActions.actions.map((action) => action.claims),
    ...payload.sourceEvidence.evidence.map((evidence) => evidence.claims)
  ];
  return new Map(
    sections.flatMap((claims) => (claims ?? []).map((claim) => [claim.id, claim] as const))
  );
}

/** Builds the in-page anchor an evidence entry answers to, so a citation marker can reach it. */
function evidenceAnchorId(number: number): string {
  return `approval-evidence-${number}`;
}

/** Converts an internal approval value into a user-facing label. */
function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
/** Formats an approval timestamp for the user's locale. */
function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}
