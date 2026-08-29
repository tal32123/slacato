import type { DealListItem } from '@slacato/contracts';
import { ArrowRight, BriefcaseBusiness } from 'lucide-react';
import { Link } from 'react-router';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function DealList({ deals }: Readonly<{ deals: readonly DealListItem[] }>): React.JSX.Element {
  if (deals.length === 0) return (
    <section className="rounded-xl border border-dashed px-6 py-12 text-center" aria-labelledby="empty-deals-title">
      <BriefcaseBusiness aria-hidden="true" className="mx-auto size-9 text-muted-foreground" />
      <h2 id="empty-deals-title" className="mt-4 text-lg font-semibold">No authorized deals</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">This signed persona has no readable opportunities. The list does not reveal hidden deal names or counts.</p>
    </section>
  );

  return (
    <section aria-labelledby="deal-list-title">
      <h2 id="deal-list-title" className="sr-only">Authorized deal records</h2>
      <div className="hidden md:block">
        <Table aria-label="Authorized deals">
          <TableCaption>Only opportunities readable by the active signed persona.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Deal</TableHead><TableHead>Stage</TableHead><TableHead>Owner</TableHead>
              <TableHead>Close</TableHead><TableHead>ACV</TableHead><TableHead>Risk</TableHead><TableHead className="text-right">Workspace</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{deals.map((deal) => <DealRow key={deal.opportunityId} deal={deal} />)}</TableBody>
        </Table>
      </div>
      <ul className="grid gap-4 md:hidden" aria-label="Authorized deals">
        {deals.map((deal) => <DealRecord key={deal.opportunityId} deal={deal} />)}
      </ul>
    </section>
  );
}

function DealRow({ deal }: Readonly<{ deal: DealListItem }>): React.JSX.Element {
  return (
    <TableRow>
      <TableCell><strong className="block font-semibold">{deal.opportunityId}</strong><span className="block max-w-sm text-sm">{deal.opportunityName}</span><span className="block text-xs text-muted-foreground">{deal.accountName}</span></TableCell>
      <TableCell>{deal.stage}</TableCell><TableCell>{deal.owner ?? 'Not recorded'}</TableCell>
      <TableCell>{deal.closeDate ?? 'Not recorded'}</TableCell><TableCell>{amount(deal)}</TableCell>
      <TableCell><StatusBadge status={deal.riskLevel === 'high' ? 'attention' : deal.riskLevel === 'low' ? 'ready' : 'readonly'} label={`${title(deal.riskLevel)} risk`} /></TableCell>
      <TableCell className="text-right"><Button asChild variant="outline"><Link to={`/deals/${deal.opportunityId}`} aria-label={`Open ${deal.opportunityId} workspace`}>Open<ArrowRight aria-hidden="true" /></Link></Button></TableCell>
    </TableRow>
  );
}

function DealRecord({ deal }: Readonly<{ deal: DealListItem }>): React.JSX.Element {
  const facts = [
    ['Opportunity', deal.opportunityName], ['Account', deal.accountName], ['Stage', deal.stage], ['Owner', deal.owner ?? 'Not recorded'],
    ['Close date', deal.closeDate ?? 'Not recorded'], ['ACV', amount(deal)], ['Probability', deal.probability === null ? 'Not recorded' : `${deal.probability}%`],
    ['Risk', `${title(deal.riskLevel)} risk`], ['Latest run', deal.latestRun === null ? 'No run yet' : `${deal.latestRun.status.replaceAll('_', ' ')} · ${new Date(deal.latestRun.updatedAt).toLocaleString()}`],
    ['Access', deal.restricted ? 'Restricted deal — authorized' : 'Standard deal']
  ] as const;
  return (
    <li className="rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-3"><div><strong className="text-base">{deal.opportunityId}</strong><p className="mt-1 text-sm text-muted-foreground">{deal.accountName}</p></div><StatusBadge status={deal.riskLevel === 'high' ? 'attention' : deal.riskLevel === 'low' ? 'ready' : 'readonly'} label={`${title(deal.riskLevel)} risk`} /></div>
      <dl className="mt-5 grid gap-3">{facts.map(([label, value]) => <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-t pt-3 text-sm"><dt className="font-medium text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}</dl>
      <Button asChild className="mt-5 w-full"><Link to={`/deals/${deal.opportunityId}`} aria-label={`Open ${deal.opportunityId} workspace`}>Open workspace<ArrowRight aria-hidden="true" /></Link></Button>
    </li>
  );
}

function amount(deal: DealListItem): string {
  if (deal.amount === null) return 'Not recorded';
  return deal.currency === null ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(deal.amount) : new Intl.NumberFormat('en-US', { style: 'currency', currency: deal.currency, maximumFractionDigits: 0 }).format(deal.amount);
}
function title(value: string): string { return `${value.charAt(0).toUpperCase()}${value.slice(1)}`; }
