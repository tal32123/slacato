import type { ApprovalBriefPayload } from '@slacato/contracts';
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
      </SubjectSection>
      <SubjectSection title="Executive summary">
        <p className="leading-7">{payload.executiveSummary.narrative}</p>
      </SubjectSection>
      <SubjectSection title="Buyer goals and business drivers">
        <BriefList
          title="Goals"
          values={payload.buyerGoalsAndBusinessDrivers.goals}
          empty="No buyer goals were supported by the validated evidence."
        />
        <BriefList
          title="Business drivers"
          values={payload.buyerGoalsAndBusinessDrivers.businessDrivers}
          empty="No business drivers were supported by the validated evidence."
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
              </li>
            ))}
          </ul>
        )}
        <BriefList
          title="Coverage gaps"
          values={payload.stakeholderMap.coverageGaps ?? []}
          empty="No stakeholder coverage gaps were recorded."
        />
      </SubjectSection>
      <SubjectSection title="Negotiation state">
        <p className="leading-7">{payload.negotiationState.currentState}</p>
        <BriefList
          title="Leverage"
          values={payload.negotiationState.leverage ?? []}
          empty="No leverage was supported by the validated evidence."
        />
        <BriefList
          title="Risks"
          values={payload.negotiationState.risks}
          empty="No negotiation risks were recorded."
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
        {payload.sourceEvidence.evidence.length === 0 ? (
          <EmptyState>No evidence summaries were included.</EmptyState>
        ) : (
          <ul className="grid gap-3">
            {payload.sourceEvidence.evidence.map((evidence) => (
              <li key={evidence.evidenceId} className="rounded-lg border p-3">
                <p>{evidence.summary}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {label(evidence.sourceType)} ·{' '}
                  <time dateTime={evidence.capturedAt}>{formatTime(evidence.capturedAt)}</time>
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
                key={warning.code}
                className="rounded-lg border border-attention bg-attention/10 p-3"
              >
                <p className="font-medium">
                  {label(warning.severity)} · {warning.code}
                </p>
                <p className="mt-1 text-sm">{warning.message}</p>
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

/** Presents a titled list from the approval brief with a meaningful empty state. */
export function BriefList({
  title,
  values,
  empty
}: Readonly<{ title: string; values: readonly string[]; empty: string }>): React.JSX.Element {
  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium">{title}</h4>
      {values.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Explains when an approval-brief section has no recorded content. */
export function EmptyState({
  children
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <p className="mt-2 text-sm text-muted-foreground">{children}</p>;
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
