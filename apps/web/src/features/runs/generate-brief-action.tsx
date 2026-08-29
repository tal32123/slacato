import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import { startBrief } from '@/api/client';
import { csrfQueryOptions, queryClient, queryKeys } from '@/api/session';
import { Button } from '@/components/ui/button';

const budget = { maxCalls: 24, maxInputTokens: 80_000, maxOutputTokens: 96_000, deadlineMs: 600_000 } as const;

export function GenerateBriefAction({ opportunityId, sessionVersion }: Readonly<{
  opportunityId: string;
  sessionVersion: string;
}>): React.JSX.Element {
  const navigate = useNavigate();
  const operationKey = useRef(crypto.randomUUID());
  const mutation = useMutation({
    mutationFn: async () => {
      const csrfToken = await queryClient.ensureQueryData(csrfQueryOptions(sessionVersion));
      return startBrief({ opportunityId, idempotencyKey: operationKey.current, budget }, csrfToken);
    },
    onSuccess: async ({ runId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(sessionVersion, `deal:${opportunityId}`) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(sessionVersion, 'deals') }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoped(sessionVersion, 'runs') })
      ]);
      await navigate(`/runs/${encodeURIComponent(runId)}`);
    }
  });

  return (
    <div data-tour="generate-brief" className="flex flex-col items-start gap-2 sm:items-end">
      <Button type="button" size="lg" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        <Sparkles aria-hidden="true" />
        {mutation.isPending ? 'Starting brief…' : 'Generate Brief'}
      </Button>
      {mutation.isError && (
        <p role="alert" className="max-w-sm text-sm text-destructive">
          The brief could not be started. Your deal context is unchanged; retry uses the same safe operation.
        </p>
      )}
    </div>
  );
}
