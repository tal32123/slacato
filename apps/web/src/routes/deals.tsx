import type { DealListResponse, DemoSession } from '@slacato/contracts';
import type { LoaderFunctionArgs } from 'react-router';
import { useLoaderData, useRouteLoaderData } from 'react-router';
import {
  queryClient,
  SessionInvalidatedError,
  sessionQueryOptions,
  sessionRuntime
} from '@/api/session';
import { DealList } from '@/features/deals/deal-list';
import { dealsQueryOptions } from '@/features/deals/queries';
import { throwProtectedLoaderError } from './loader-security';

/** Loads the deal list while preserving protected-session transition guarantees. */
export async function dealsLoader({
  request
}: LoaderFunctionArgs): Promise<DealListResponse | null> {
  try {
    const session = await queryClient.fetchQuery(sessionQueryOptions());
    if (!session.authenticated) return null;
    return await queryClient.fetchQuery(dealsQueryOptions(session.version));
  } catch (error) {
    if (error instanceof SessionInvalidatedError) {
      try {
        const session = await queryClient.fetchQuery(sessionQueryOptions());
        if (session.authenticated) {
          const deals = await queryClient.fetchQuery(dealsQueryOptions(session.version));
          sessionRuntime.finishTransition();
          return deals;
        }
      } catch (retryError) {
        throwProtectedLoaderError(retryError, request);
      }
    }
    throwProtectedLoaderError(error, request);
  }
}

/** Presents the deals available to the current persona and their latest workflow state. */
export function DealsRoute(): React.JSX.Element {
  const response = useLoaderData() as DealListResponse;
  const session = useRouteLoaderData('protected-root') as DemoSession;
  return (
    <div className="grid gap-7">
      <header className="max-w-4xl">
        <p className="text-sm font-medium text-primary">Authorized deal preparation</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Authorized deals</h1>
        <h2 className="mt-3 text-base font-semibold">
          Welcome, {session.persona.displayName.split(/\s+/)[0] ?? session.persona.displayName}
        </h2>
        <p className="mt-2 max-w-3xl leading-7 text-muted-foreground">
          Every opportunity below is reauthorized at the database query boundary for{' '}
          {session.persona.role}. Open a brief-first workspace to review source-backed negotiation
          preparation and citations.
        </p>
      </header>
      <DealList deals={response.deals} />
    </div>
  );
}
