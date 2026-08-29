import type { PermissionGrantView } from '@slacato/contracts';
import { Check, Minus } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';

const sourceLabels: Readonly<Record<string, string>> = {
  account: 'Salesforce account',
  opportunity: 'Salesforce opportunity',
  contact: 'Salesforce contact',
  gong_summary: 'Gong summary',
  gong_transcript: 'Gong transcript',
  slack_update: 'Account-team update',
  pricing_note: 'Pricing note',
  pricing: 'Pricing records',
  salesforce: 'Salesforce records',
  gong: 'Gong records',
  slack: 'Account-team updates',
  policies: 'Policy',
  policy: 'Policy'
};

const authorityColumns = [
  { label: 'Account Owner', key: 'accountOwner' },
  { label: 'Sales Leader', key: 'salesLeader' },
  { label: 'Deal Desk', key: 'dealDesk' },
  { label: 'Legal Reviewer', key: 'legalReviewer' }
] as const;

export function PermissionMatrix({ grants }: Readonly<{ grants: readonly PermissionGrantView[] }>): React.JSX.Element {
  if (grants.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-5 py-8 text-sm text-muted-foreground">
        This persona has no readable grants in the canonical permission fixture.
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-hidden rounded-lg border lg:block">
        <Table aria-label="Permission and decision authority matrix">
          <TableCaption className="sr-only">Permission and decision authority matrix</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Account</TableHead>
              <TableHead scope="col">Source</TableHead>
              <TableHead scope="col">Restricted access</TableHead>
              <TableHead scope="col">Sensitive pricing</TableHead>
              <TableHead scope="col">Request permission</TableHead>
              {authorityColumns.map(({ label }) => <TableHead scope="col" key={label}>{label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((grant) => (
              <TableRow key={`${grant.accountId}:${grant.sourceType}`}>
                <TableCell className="font-medium">{grant.accountId}</TableCell>
                <TableCell>{sourceLabels[grant.sourceType] ?? grant.sourceType}</TableCell>
                <TableCell><BooleanValue value={grant.restrictedOpportunityAccess} /></TableCell>
                <TableCell><BooleanValue value={grant.sensitivePricing} /></TableCell>
                <TableCell><BooleanValue value={grant.canRequestApproval} /></TableCell>
                {authorityColumns.map(({ label, key }) => (
                  <TableCell key={label}><BooleanValue value={grant.decisionAuthority[key]} /></TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul aria-label="Permission and decision authority matrix" className="grid gap-3 lg:hidden">
        {grants.map((grant) => (
          <li key={`${grant.accountId}:${grant.sourceType}`}>
            <section className="rounded-lg border bg-card p-4">
              <h3 className="font-medium">{grant.accountId}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{sourceLabels[grant.sourceType] ?? grant.sourceType}</p>
              <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
                <MatrixValue label="Restricted access" value={grant.restrictedOpportunityAccess} />
                <MatrixValue label="Sensitive pricing" value={grant.sensitivePricing} />
                <MatrixValue label="Request permission" value={grant.canRequestApproval} />
                {authorityColumns.map(({ label, key }) => (
                  <MatrixValue key={label} label={`${label} authority`} value={grant.decisionAuthority[key]} />
                ))}
              </dl>
            </section>
          </li>
        ))}
      </ul>
    </>
  );
}

function BooleanValue({ value }: Readonly<{ value: boolean }>): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      {value ? <Check aria-hidden="true" className="size-4 text-primary" /> : <Minus aria-hidden="true" className="size-4 text-muted-foreground" />}
      {value ? 'Yes' : 'No'}
    </span>
  );
}

function MatrixValue({ label, value }: Readonly<{ label: string; value: boolean }>): React.JSX.Element {
  return <><dt className="text-muted-foreground">{label}</dt><dd><BooleanValue value={value} /></dd></>;
}
