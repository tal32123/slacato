import type { DealWorkspaceView } from '@slacato/contracts';
import type { LoaderFunctionArgs } from 'react-router';
import { useLoaderData } from 'react-router';
import {
  queryClient,
  SessionInvalidatedError,
  sessionQueryOptions,
  sessionRuntime
} from '@/api/session';
import { DealBrief } from '@/features/briefs/deal-brief';
import { EvidenceExplorer } from '@/features/briefs/evidence-explorer';
import { dealWorkspaceQueryOptions } from '@/features/deals/queries';
import { GenerateBriefAction } from '@/features/runs/generate-brief-action';
import { throwProtectedLoaderError } from './loader-security';

/** Loads the requested deal workspace while preserving protected-session transition guarantees. */
export async function dealLoader({
  request,
  params
}: LoaderFunctionArgs): Promise<DealWorkspaceView | null> {
  const opportunityId = params.opportunityId;
  if (!opportunityId) throw new Response('Invalid deal route', { status: 400 });
  try {
    const session = await queryClient.fetchQuery(sessionQueryOptions());
    if (!session.authenticated) return null;
    return await queryClient.fetchQuery(dealWorkspaceQueryOptions(session.version, opportunityId));
  } catch (error) {
    if (error instanceof SessionInvalidatedError) {
      try {
        const session = await queryClient.fetchQuery(sessionQueryOptions());
        if (session.authenticated) {
          const workspace = await queryClient.fetchQuery(
            dealWorkspaceQueryOptions(session.version, opportunityId)
          );
          sessionRuntime.finishTransition();
          return workspace;
        }
      } catch (retryError) {
        throwProtectedLoaderError(retryError, request);
      }
    }
    throwProtectedLoaderError(error, request);
  }
}

/** Presents a deal workspace and lets users inspect the evidence behind its brief. */
export function DealRoute(): React.JSX.Element {
  const workspace = useLoaderData() as DealWorkspaceView;
  return (
    <EvidenceExplorer evidence={workspace.evidence}>
      {({ selectedEvidenceId, onEvidence }) => (
        <DealBrief
          workspace={workspace}
          selectedEvidenceId={selectedEvidenceId}
          onEvidence={onEvidence}
          primaryAction={
            <GenerateBriefAction
              opportunityId={workspace.deal.opportunityId}
              sessionVersion={workspace.sessionVersion}
            />
          }
        />
      )}
    </EvidenceExplorer>
  );
}
