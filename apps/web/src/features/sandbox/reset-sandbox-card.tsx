import type { SandboxResetReportView, SandboxResetTallyView } from '@slacato/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eraser } from 'lucide-react';
import { useState } from 'react';
import { fetchSandboxReset, resetSandbox } from '@/api/client';
import { csrfQueryOptions, queryClient, queryKeys } from '@/api/session';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** The record families a reset removes, in the order a reviewer asks about them. */
const ERASED_LABELS: readonly Readonly<{
  key: keyof SandboxResetTallyView;
  one: string;
  many: string;
}>[] = [
  { key: 'runs', one: 'run', many: 'runs' },
  { key: 'approvalSubjects', one: 'approval request', many: 'approval requests' },
  { key: 'approvalDecisions', one: 'approval decision', many: 'approval decisions' },
  { key: 'briefs', one: 'generated brief', many: 'generated briefs' },
  { key: 'runEvents', one: 'run event', many: 'run events' },
  { key: 'traceSpans', one: 'trace span', many: 'trace spans' },
  { key: 'queuedCommands', one: 'queued command', many: 'queued commands' },
  { key: 'auditEvents', one: 'run audit record', many: 'run audit records' }
];

/**
 * Returns the demo to a never-run state, where that is a thing this deployment can do.
 *
 * The control renders only once `/api/sandbox/reset` has answered. It never answers in a deployment
 * that was not designated a sandbox, nor for a persona without standing to clear one, so both cases
 * end with no control on the page at all - and because the card waits for a successful answer
 * rather than hiding on failure, it does not flash into view first. That is deliberate: a
 * greyed-out "Reset sandbox" button would tell every visitor to a public URL that the capability
 * exists and invite them to look for the way in, and nothing a disabled control communicates here
 * is communicated worse by its absence.
 *
 * Confirmation names counts the server reported a moment earlier rather than warning generically,
 * and the card states the boundary in both directions - what goes and what stays - because the
 * surprising half of a reset is always the half it leaves alone.
 */
export function ResetSandboxCard({
  sessionVersion
}: Readonly<{ sessionVersion: string }>): React.JSX.Element | null {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<SandboxResetReportView | undefined>(undefined);
  const preview = useQuery({
    queryKey: queryKeys.scoped(sessionVersion, 'sandbox-reset'),
    queryFn: ({ signal }) => fetchSandboxReset(signal),
    retry: false,
    staleTime: 0
  });
  const csrf = useQuery(csrfQueryOptions(sessionVersion));
  const mutation = useMutation({
    mutationFn: async () => {
      const csrfToken = await queryClient.ensureQueryData(csrfQueryOptions(sessionVersion));
      return resetSandbox(csrfToken);
    },
    onSuccess: async (report) => {
      setOutcome(report);
      setConfirming(false);
      // Every list in the interface is now describing runs that no longer exist, so the session's
      // cached views are dropped rather than left to expire: the deal list, the approval inbox and
      // the run history have to come back empty the moment the user navigates to any of them.
      await client.invalidateQueries({ predicate: ({ queryKey }) => queryKey[0] === 'scoped' });
    }
  });

  const report = preview.data;
  if (report === undefined) return null;
  const busy = mutation.isPending;

  return (
    <Card className="gap-4 border-destructive/40 shadow-none">
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-md bg-destructive/10 text-destructive">
            <Eraser aria-hidden="true" />
          </span>
          <div>
            <CardTitle>Reset sandbox</CardTitle>
            <CardDescription>
              Return database &ldquo;{report.database}&rdquo; to a never-run state
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-6 text-muted-foreground">
          Erases everything the demo produced by being run: runs, approval requests and their
          decisions, generated briefs, run events, traces, queued work, and run-bound audit records.
        </p>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Keeps everything that was ingested — personas, permission grants, accounts, opportunities,
          contacts, documents, and evidence with its embeddings — so nothing needs re-ingesting and
          brief generation stays ready. Your signed-in session is kept as well.
        </p>

        <TallyList tally={report.tally} />

        {report.tally.runsInFlight > 0 && (
          <p className="mt-3 text-sm leading-6 text-attention-foreground">
            {report.tally.runsInFlight === 1
              ? '1 run is generating right now.'
              : `${report.tally.runsInFlight} runs are generating right now.`}{' '}
            Resetting discards that work; a step already handed to the worker fails once and is set
            aside.
          </p>
        )}

        {outcome !== undefined && (
          <p role="status" className="mt-4 text-sm leading-6">
            Sandbox reset: {describeErased(outcome.tally)} removed.{' '}
            {outcome.retained.evidenceVersions} evidence versions and{' '}
            {outcome.retained.opportunities} opportunities were kept.
          </p>
        )}

        {mutation.isError && (
          <p role="alert" className="mt-4 text-sm leading-6 text-destructive">
            The sandbox could not be reset, and nothing was removed — the reset commits as a single
            transaction, so a failure leaves the sandbox exactly as it was.
          </p>
        )}

        <Button
          type="button"
          variant="destructive"
          className="mt-5 min-h-11"
          data-testid="reset-sandbox"
          disabled={csrf.data === undefined || busy}
          onClick={() => {
            setOutcome(undefined);
            void preview.refetch();
            setConfirming(true);
          }}
        >
          <Eraser aria-hidden="true" />
          {busy ? 'Resetting sandbox…' : 'Reset sandbox'}
        </Button>

        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Erase every run in &ldquo;{report.database}&rdquo;?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This permanently deletes {describeErased(report.tally)}. Ingested fixture data —{' '}
                {report.retained.evidenceVersions} evidence versions across{' '}
                {report.retained.opportunities} opportunities, and all {report.retained.personas}{' '}
                personas with their grants — is kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <TallyList tally={report.tally} />
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Keep the data</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  mutation.mutate();
                }}
              >
                {busy ? 'Resetting…' : 'Reset sandbox'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

/** Lists each record family with the count the server reported for it. */
function TallyList({ tally }: Readonly<{ tally: SandboxResetTallyView }>): React.JSX.Element {
  return (
    <dl className="mt-4 grid gap-y-1 text-sm">
      {ERASED_LABELS.map(({ key, many }) => (
        <div key={key} className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{many}</dt>
          <dd className="font-medium tabular-nums">{tally[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Renders the counts as the prose a confirmation should read like.
 *
 * Families with nothing in them are left out and singulars agree, because a sentence reading
 * "1 runs, 0 generated briefs" is the kind of detail that makes a reader stop trusting the number
 * they are being asked to approve.
 */
export function describeErased(tally: SandboxResetTallyView): string {
  const parts = ERASED_LABELS.filter(({ key }) => tally[key] > 0).map(
    ({ key, one, many }) => `${tally[key]} ${tally[key] === 1 ? one : many}`
  );
  if (parts.length === 0) return 'nothing — this sandbox already has no run history';
  const last = parts.at(-1) ?? '';
  return parts.length === 1 ? last : `${parts.slice(0, -1).join(', ')} and ${last}`;
}
