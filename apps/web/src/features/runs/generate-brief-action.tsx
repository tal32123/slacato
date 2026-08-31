import { useMutation, useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useRef } from 'react';
import { Link, useNavigate } from 'react-router';
import { startBrief } from '@/api/client';
import { csrfQueryOptions, queryClient, queryKeys, readinessQueryOptions } from '@/api/session';
import { advanceGuidedTour } from '@/components/guided-tour';
import { Button } from '@/components/ui/button';
import { describeGenerationReadiness } from './generation-readiness';

/** Lets a seller start a brief-generation run and opens the resulting run workspace. */
export function GenerateBriefAction({
  opportunityId,
  sessionVersion
}: Readonly<{
  opportunityId: string;
  sessionVersion: string;
}>): React.JSX.Element {
  const navigate = useNavigate();
  const operationKey = useRef(crypto.randomUUID());
  const readiness = useQuery(readinessQueryOptions());
  const gate = describeGenerationReadiness(readiness.data, readiness.isError);
  const mutation = useMutation({
    mutationFn: async () => {
      const csrfToken = await queryClient.ensureQueryData(csrfQueryOptions(sessionVersion));
      return startBrief({ opportunityId, idempotencyKey: operationKey.current }, csrfToken);
    },
    onSuccess: async ({ runId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.scoped(sessionVersion, `deal:${opportunityId}`)
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(sessionVersion, 'deals') }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(sessionVersion, 'runs') })
      ]);
      advanceGuidedTour('generate-brief');
      await navigate(`/runs/${encodeURIComponent(runId)}`);
    }
  });

  return (
    <div data-tour="generate-brief" className="flex flex-col items-start gap-2 sm:items-end">
      <Button
        type="button"
        size="lg"
        disabled={mutation.isPending || gate.blocked}
        aria-describedby={gate.blocked ? 'generate-brief-gate-reason' : undefined}
        onClick={() => mutation.mutate()}
      >
        <Sparkles aria-hidden="true" />
        {mutation.isPending ? 'Starting brief…' : 'Generate Brief'}
      </Button>
      {gate.blocked && (
        <p
          id="generate-brief-gate-reason"
          role="status"
          className="max-w-sm text-sm text-attention-foreground sm:text-right"
        >
          {gate.reason}{' '}
          <Link to="/diagnostics" className="underline underline-offset-2">
            Check Diagnostics
          </Link>
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="max-w-sm text-sm text-destructive">
          The brief could not be started. Your deal context is unchanged; retry uses the same safe
          operation.
        </p>
      )}
    </div>
  );
}
