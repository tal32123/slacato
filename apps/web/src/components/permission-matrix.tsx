import type { AccountApprovalAuthorityView, ApprovalAuthority, PermissionGrantView } from '@slacato/contracts';
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

const authorityColumns: readonly Readonly<{ label: string; key: ApprovalAuthority }>[] = [
  { label: 'Account Owner', key: 'account_owner' },
  { label: 'Sales Leader', key: 'sales_leader' },
  { label: 'Deal Desk', key: 'deal_desk' },
  { label: 'Legal Reviewer', key: 'legal_reviewer' }
];

/** Renders source permissions and account approval authorities as separate canonical facts. */
export function PermissionMatrix({
  grants,
  approvalAuthorities
}: Readonly<{
  grants: readonly PermissionGrantView[];
  approvalAuthorities: readonly AccountApprovalAuthorityView[];
}>): React.JSX.Element {
  return (
    <>
      {grants.length === 0 ? (
        <div className="rounded-lg border border-dashed px-5 py-8 text-sm text-muted-foreground">
          This persona has no source permissions in the canonical fixture.
        </div>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-lg border lg:block">
            <Table aria-label="Source permission matrix" tabIndex={0}>
              <TableCaption className="sr-only">Source permission matrix</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Account</TableHead>
                  <TableHead scope="col">Source</TableHead>
                  <TableHead scope="col">Read permission</TableHead>
                  <TableHead scope="col">Can access restricted opportunities</TableHead>
                  <TableHead scope="col">Can view sensitive pricing</TableHead>
                  <TableHead scope="col">Request permission</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((grant) => (
                  <TableRow key={`${grant.accountId}:${grant.sourceType}`}>
                    <TableCell className="font-medium">{grant.accountId}</TableCell>
                    <TableCell>{sourceLabels[grant.sourceType] ?? grant.sourceType}</TableCell>
                    <TableCell><BooleanValue value={grant.canRead} /></TableCell>
                    <TableCell><BooleanValue value={grant.restrictedOpportunityAccess} /></TableCell>
                    <TableCell><BooleanValue value={grant.sensitivePricing} /></TableCell>
                    <TableCell><BooleanValue value={grant.canRequestApproval} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul aria-label="Source permission matrix" className="grid gap-3 lg:hidden">
            {grants.map((grant) => (
              <li key={`${grant.accountId}:${grant.sourceType}`}>
                <section className="rounded-lg border bg-card p-4">
                  <h3 className="font-medium">{grant.accountId}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{sourceLabels[grant.sourceType] ?? grant.sourceType}</p>
                  <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
                    <MatrixValue label="Read permission" value={grant.canRead} />
                    <MatrixValue label="Can access restricted opportunities" value={grant.restrictedOpportunityAccess} />
                    <MatrixValue label="Can view sensitive pricing" value={grant.sensitivePricing} />
                    <MatrixValue label="Request permission" value={grant.canRequestApproval} />
                  </dl>
                </section>
              </li>
            ))}
          </ul>
        </>
      )}

      <section className="mt-6" aria-labelledby="approval-authority-title">
        <h3 id="approval-authority-title" className="text-sm font-semibold">Account approval authority</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          These account-scoped grants come from the approval decision authority table, independently of source access.
        </p>
        {approvalAuthorities.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed px-5 py-6 text-sm text-muted-foreground">
            This persona has no approval authority in the canonical fixture.
          </div>
        ) : (
          <>
            <div className="mt-3 hidden overflow-hidden rounded-lg border lg:block">
              <Table aria-label="Account approval authority matrix" tabIndex={0}>
                <TableCaption className="sr-only">Account approval authority matrix</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Account</TableHead>
                    {authorityColumns.map(({ label }) => <TableHead scope="col" key={label}>{label}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {approvalAuthorities.map((grant) => (
                    <TableRow key={grant.accountId}>
                      <TableCell className="font-medium">{grant.accountId}</TableCell>
                      {authorityColumns.map(({ label, key }) => (
                        <TableCell key={label}><BooleanValue value={grant.authorities.includes(key)} /></TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <ul aria-label="Account approval authority matrix" className="mt-3 grid gap-3 lg:hidden">
              {approvalAuthorities.map((grant) => (
                <li key={grant.accountId}>
                  <section className="rounded-lg border bg-card p-4">
                    <h4 className="font-medium">{grant.accountId}</h4>
                    <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
                      {authorityColumns.map(({ label, key }) => (
                        <MatrixValue key={label} label={`${label} authority`} value={grant.authorities.includes(key)} />
                      ))}
                    </dl>
                  </section>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
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
