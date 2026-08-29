import type { ReactNode } from 'react';
import type { DealWorkspaceView, RecommendedActionView, StakeholderView } from '@slacato/contracts';
import { AlertTriangle, ArrowLeft, CalendarDays, CircleDollarSign, Gauge, UserRound } from 'lucide-react';
import { Link } from 'react-router';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDealAmount } from '@/features/deals/deal-format';

const sectionOrder = [
  'dealSnapshot', 'executiveSummary', 'buyerGoalsAndBusinessDrivers', 'stakeholderMap', 'negotiationState',
  'recommendedNextActions', 'missingInformation', 'sourceEvidence', 'confidenceAndReviewWarnings'
] as const;

export function DealBrief({ workspace, selectedEvidenceId, onEvidence, primaryAction }: Readonly<{
  workspace: DealWorkspaceView;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
  primaryAction: ReactNode;
}>): React.JSX.Element {
  const { deal, brief } = workspace;
  const evidence = new Map(workspace.evidence.map((item) => [item.id, item]));
  return (
    <article data-deal-main className="min-w-0">
      <Button asChild variant="link" className="min-h-11 px-0"><Link to="/deals"><ArrowLeft aria-hidden="true" />Back to authorized deals</Link></Button>
      <header className="mt-3 border-b pb-7">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={deal.restricted ? 'attention' : 'ready'} label={deal.restricted ? 'Restricted — authorized' : 'Authorized workspace'} /><StatusBadge status="readonly" label={brief.status === 'generated' ? 'Generated brief' : 'Source-backed brief'} /></div>
            <p className="mt-4 text-sm font-medium text-primary">{deal.opportunityId}</p>
            <h1 className="mt-1 max-w-4xl text-3xl font-semibold tracking-tight sm:text-4xl">{deal.opportunityName}</h1>
            <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">Brief-first negotiation preparation for {deal.accountName}. Suggestions remain internal and require seller judgment.</p>
          </div>
          {primaryAction}
        </div>
      </header>

      <section className="grid gap-3 border-b py-6 sm:grid-cols-2 xl:grid-cols-4" aria-label="Deal metrics">
        <Metric icon={CircleDollarSign} label="Annual contract value" value={formatDealAmount(deal)} />
        <Metric icon={CalendarDays} label="Close date" value={deal.closeDate ?? 'Not recorded'} />
        <Metric icon={Gauge} label="Stage and risk" value={`${deal.stage} · ${title(deal.riskLevel)} risk`} />
        <Metric icon={UserRound} label="Owner and latest run" value={`${deal.owner ?? 'Owner not recorded'} · ${deal.latestRun === null ? 'No run yet' : deal.latestRun.status.replaceAll('_', ' ')}`} />
      </section>

      <div>
        {sectionOrder.map((id) => {
          const section = brief.sections[id];
          return (
            <section key={id} className="border-b py-8" aria-labelledby={`brief-${id}`}>
              <div className="flex flex-wrap items-center justify-between gap-3"><h2 id={`brief-${id}`} className="text-xl font-semibold">{section.title}</h2>{section.accountTeamUpdateImpact && <StatusBadge status="attention" label="Account-team update impact" />}</div>
              <div className="mt-4 grid gap-3 text-sm leading-6 sm:text-base">{section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
              {section.items.length > 0 && <ul className="mt-4 grid gap-2 pl-5 text-sm leading-6 marker:text-primary sm:text-base">{section.items.map((item) => <li key={item}>{item}</li>)}</ul>}
              {id === 'stakeholderMap' && <Stakeholders stakeholders={brief.stakeholders} />}
              {id === 'recommendedNextActions' && <Actions actions={brief.actions} />}
              {id === 'confidenceAndReviewWarnings' && <Warnings warnings={brief.warnings} />}
              <CitationControls citationIds={section.citationIds} evidence={evidence} selectedEvidenceId={selectedEvidenceId} onEvidence={onEvidence} />
            </section>
          );
        })}
      </div>
    </article>
  );
}

function Metric({ icon: Icon, label, value }: Readonly<{ icon: typeof Gauge; label: string; value: string }>): React.JSX.Element {
  return <div className="flex min-w-0 items-start gap-3 rounded-lg border bg-card p-4"><Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" /><div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 break-words text-sm font-semibold">{value}</p></div></div>;
}

function CitationControls({ citationIds, evidence, selectedEvidenceId, onEvidence }: Readonly<{
  citationIds: readonly string[];
  evidence: ReadonlyMap<string, DealWorkspaceView['evidence'][number]>;
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
}>): React.JSX.Element | null {
  const citations = citationIds.map((id) => evidence.get(id)).filter((item): item is DealWorkspaceView['evidence'][number] => item !== undefined);
  if (citations.length === 0) return null;
  return <ul className="mt-5 flex flex-wrap gap-2" aria-label="Section citations">{citations.map((citation) => (
    <li key={citation.id} className="max-w-full"><Button type="button" variant={selectedEvidenceId === citation.id ? 'secondary' : 'outline'} className="h-auto min-h-11 max-w-full justify-start whitespace-normal break-words text-left text-xs" aria-label={`Open evidence: ${citation.citationLabel}`} aria-pressed={selectedEvidenceId === citation.id} onClick={(event) => onEvidence(citation.id, event.currentTarget)}>{citation.citationLabel}</Button></li>
  ))}</ul>;
}

function Stakeholders({ stakeholders }: Readonly<{ stakeholders: readonly StakeholderView[] }>): React.JSX.Element {
  if (stakeholders.length === 0) return <p className="mt-5 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No authorized stakeholder records are available.</p>;
  return <div className="mt-6"><div className="hidden md:block overflow-x-auto"><Table aria-label="Stakeholders"><TableCaption>Complete authorized stakeholder records.</TableCaption><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Role</TableHead><TableHead>Influence</TableHead><TableHead>Relationship</TableHead><TableHead>Goals</TableHead><TableHead>Concerns</TableHead></TableRow></TableHeader><TableBody>{stakeholders.map((stakeholder) => <TableRow key={stakeholder.name}><TableCell><strong>{stakeholder.name}</strong><span className="block text-xs text-muted-foreground">{stakeholder.title ?? 'Title not recorded'}</span></TableCell><TableCell>{stakeholder.role}</TableCell><TableCell>{stakeholder.influence}</TableCell><TableCell>{stakeholder.relationship}</TableCell><TableCell className="max-w-xs whitespace-normal">{stakeholder.goals.join(' ') || 'None recorded'}</TableCell><TableCell className="max-w-xs whitespace-normal">{stakeholder.concerns.join(' ') || 'None recorded'}</TableCell></TableRow>)}</TableBody></Table></div><ul className="grid gap-3 md:hidden" aria-label="Stakeholders">{stakeholders.map((stakeholder) => <li key={stakeholder.name} className="rounded-lg border p-4"><strong>{stakeholder.name}</strong><dl className="mt-3 grid gap-2 text-sm"><Fact label="Title" value={stakeholder.title ?? 'Not recorded'} /><Fact label="Role" value={stakeholder.role} /><Fact label="Influence" value={stakeholder.influence} /><Fact label="Relationship" value={stakeholder.relationship} /><Fact label="Goals" value={stakeholder.goals.join(' ') || 'None recorded'} /><Fact label="Concerns" value={stakeholder.concerns.join(' ') || 'None recorded'} /></dl></li>)}</ul></div>;
}

function Actions({ actions }: Readonly<{ actions: readonly RecommendedActionView[] }>): React.JSX.Element {
  if (actions.length === 0) return <p className="mt-5 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No source-backed actions are available.</p>;
  return <div className="mt-6"><div className="hidden md:block"><Table aria-label="Recommended actions"><TableCaption>Source-backed next actions; no action sends customer-facing content.</TableCaption><TableHeader><TableRow><TableHead>Action</TableHead><TableHead>Owner</TableHead><TableHead>Priority</TableHead><TableHead>Due</TableHead><TableHead>Rationale</TableHead></TableRow></TableHeader><TableBody>{actions.map((action) => <TableRow key={action.action}><TableCell className="font-medium">{action.action}{action.accountTeamUpdateImpact && <span className="mt-1 block text-xs font-medium text-attention-foreground">Account-team update impact</span>}</TableCell><TableCell>{action.owner ?? 'Not assigned'}</TableCell><TableCell>{action.priority}</TableCell><TableCell>{action.dueDate ?? 'Not recorded'}</TableCell><TableCell className="max-w-sm">{action.rationale}</TableCell></TableRow>)}</TableBody></Table></div><ul className="grid gap-3 md:hidden" aria-label="Recommended actions">{actions.map((action) => <li key={action.action} className="rounded-lg border p-4"><strong>{action.action}</strong>{action.accountTeamUpdateImpact && <p className="mt-2 text-xs font-semibold text-attention-foreground">Account-team update impact</p>}<dl className="mt-3 grid gap-2 text-sm"><Fact label="Owner" value={action.owner ?? 'Not assigned'} /><Fact label="Priority" value={action.priority} /><Fact label="Due" value={action.dueDate ?? 'Not recorded'} /><Fact label="Rationale" value={action.rationale} /></dl></li>)}</ul></div>;
}

function Warnings({ warnings }: Readonly<{ warnings: DealWorkspaceView['brief']['warnings'] }>): React.JSX.Element | null {
  if (warnings.length === 0) return null;
  return <ul className="mt-5 grid gap-3">{warnings.map((warning) => <li key={warning.message} className="flex items-start gap-3 rounded-lg border border-attention bg-attention/10 p-4 text-sm"><AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-attention-foreground" /><div><strong className="capitalize">{warning.severity}</strong><p className="mt-1 leading-6">{warning.message}</p>{warning.accountTeamUpdateImpact && <p className="mt-2 text-xs font-semibold text-attention-foreground">Account-team update impact</p>}</div></li>)}</ul>;
}
function Fact({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element { return <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3"><dt className="font-medium text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>; }
function title(value: string): string { return `${value.charAt(0).toUpperCase()}${value.slice(1)}`; }
