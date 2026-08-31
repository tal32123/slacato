import type { AuthSessionResponse } from '@slacato/contracts';
import { QueryClient, queryOptions } from '@tanstack/react-query';
import {
  ApiError,
  changePersona,
  endSession,
  fetchCsrf,
  fetchDiagnostics,
  fetchPersonas,
  fetchSession
} from './client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: false }
  }
});

export const queryKeys = {
  session: ['session'] as const,
  personas: ['personas'] as const,
  csrf: (version: string) => ['csrf', version] as const,
  scoped: (version: string, resource: string) => ['scoped', version, resource] as const
};

/** Defines how the interface loads and refreshes the current signed session. */
export const sessionQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => fetchSession(signal),
    staleTime: 0
  });

/** Defines how the interface loads the personas available to the current user. */
export const personasQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.personas,
    queryFn: ({ signal }) => fetchPersonas(signal),
    staleTime: 5 * 60_000
  });

/** Defines how the interface loads a CSRF token for a specific session version. */
export const csrfQueryOptions = (version: string) =>
  queryOptions({
    queryKey: queryKeys.csrf(version),
    queryFn: ({ signal }) => fetchCsrf(signal),
    staleTime: 0
  });

/** Signals that protected data became stale because the signed session changed during loading. */
export class SessionInvalidatedError extends Error {
  /** Creates the stable error shown when a protected request outlives its session. */
  public constructor() {
    super('The signed session changed while protected data was loading.');
  }
}

/** Defines session-aware loading for the demo diagnostics view. */
export const diagnosticsQueryOptions = (version: string) => {
  const generation = sessionRuntime.generation;
  return queryOptions({
    queryKey: queryKeys.scoped(version, 'diagnostics'),
    retry: false,
    queryFn: async ({ signal }) => {
      const diagnostics = await fetchDiagnostics(signal);
      if (diagnostics.sessionVersion !== version || !sessionRuntime.accepts(generation)) {
        await sessionRuntime.reconcileAuthoritativeSession(
          queryKeys.scoped(version, 'diagnostics')
        );
        throw new SessionInvalidatedError();
      }
      return diagnostics;
    }
  });
};

interface ClosableStream {
  close(): void;
}

type SessionBroadcast = Readonly<{
  source: string;
  kind: 'persona' | 'logout' | 'invalidate';
  version?: string;
}>;

/** Coordinates session changes across cached data, open interface surfaces, streams, and browser tabs. */
class SessionRuntime {
  private readonly source = crypto.randomUUID();
  private readonly streams = new Set<ClosableStream>();
  private readonly overlayClosers = new Set<() => void>();
  private readonly channel =
    typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('slacato-session');
  private connectionGeneration = 0;
  private transitionInProgress = false;
  private readonly transitionListeners = new Set<() => void>();

  /** Connects cross-tab session messages to local transition handling. */
  public constructor() {
    this.channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (!isSessionBroadcast(event.data) || event.data.source === this.source) return;
      this.prepareTransition();
      queryClient.removeQueries({ queryKey: queryKeys.session });
      void this.resolveBroadcast(event.data.kind);
    });
  }

  /** Reports the current connection generation used to reject stale protected responses. */
  public get generation(): number {
    return this.connectionGeneration;
  }

  /** Reports whether the interface is currently reconciling a session change. */
  public get transitioning(): boolean {
    return this.transitionInProgress;
  }

  /** Registers a listener for session-transition state changes. */
  public subscribe(listener: () => void): () => void {
    this.transitionListeners.add(listener);
    return () => this.transitionListeners.delete(listener);
  }

  /** Tracks a protected event stream so session changes can close it immediately. */
  public registerStream(stream: ClosableStream): () => void {
    this.streams.add(stream);
    return () => this.streams.delete(stream);
  }

  /** Tracks an open protected overlay so session changes can dismiss it immediately. */
  public registerOverlayCloser(close: () => void): () => void {
    this.overlayClosers.add(close);
    return () => this.overlayClosers.delete(close);
  }

  /** Determines whether work started in a connection generation is still current. */
  public accepts(generation: number): boolean {
    return generation === this.connectionGeneration;
  }

  /**
   * Begins a session transition by closing protected surfaces and clearing session-scoped data.
   *
   * By default this also blanks the rendered shell (via `transitioning`) until `finishTransition`
   * runs, which is correct when the current page has no way to know the outcome on its own -- a
   * cross-tab broadcast, or reconciling after a request whose result is ambiguous. Pass
   * `blank: false` when the transition is being driven by the very page the user is looking at
   * (the Settings persona switch): the teardown of session-scoped queries, streams, and overlays
   * below must still happen immediately for security, but there is nothing to protect by also
   * unmounting the page out from under its own in-flight mutation -- that page already renders its
   * own "Changing persona…" state, and un-mounting it besides races the mutation's latency against
   * whatever the user or a test does next for no safety benefit.
   */
  public prepareTransition(
    preserveQueryKey?: readonly unknown[],
    options?: Readonly<{ blank?: boolean }>
  ): void {
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    this.connectionGeneration += 1;
    if (options?.blank !== false) {
      this.transitionInProgress = true;
      this.notifyTransition();
    }
    for (const close of this.overlayClosers) close();
    this.overlayClosers.clear();
    const shouldTearDown = ({ queryKey }: { queryKey: readonly unknown[] }): boolean =>
      (queryKey[0] === 'scoped' || queryKey[0] === 'csrf') &&
      (preserveQueryKey === undefined || !sameQueryKey(queryKey, preserveQueryKey));
    void queryClient.cancelQueries({ predicate: shouldTearDown });
    queryClient.removeQueries({ predicate: shouldTearDown });
  }

  /** Completes a recoverable transition and notifies the interface that normal interaction may resume. */
  public finishTransition(): void {
    if (!this.transitionInProgress) return;
    this.transitionInProgress = false;
    this.notifyTransition();
  }

  /** Reconciles local state with the authoritative server session after protected data becomes stale. */
  public async reconcileAuthoritativeSession(
    preserveQueryKey?: readonly unknown[]
  ): Promise<AuthSessionResponse> {
    this.prepareTransition(preserveQueryKey);
    queryClient.removeQueries({ queryKey: queryKeys.session });
    this.broadcast('invalidate');
    return queryClient.fetchQuery(sessionQueryOptions());
  }
  /** Applies a session transition announced by another browser tab. */
  private async resolveBroadcast(kind: SessionBroadcast['kind']): Promise<void> {
    if (kind === 'logout') {
      window.location.replace('/login');
      return;
    }
    if (kind === 'persona') {
      window.location.reload();
      return;
    }
    try {
      const session = await queryClient.fetchQuery(sessionQueryOptions());
      if (session.authenticated) window.location.reload();
      else window.location.replace('/login');
    } catch {
      window.location.reload();
    }
  }

  /** Notifies subscribers that the session-transition state changed. */
  private notifyTransition(): void {
    for (const listener of this.transitionListeners) listener();
  }

  /** Announces a local session change to other browser tabs. */
  public broadcast(kind: SessionBroadcast['kind'], version?: string): void {
    this.channel?.postMessage({ source: this.source, kind, version } satisfies SessionBroadcast);
  }
}

export const sessionRuntime = new SessionRuntime();

/** Switches personas while keeping session and CSRF caches aligned with the server result. */
export async function selectPersonaSession(
  userId: string,
  csrfToken: string
): Promise<Extract<AuthSessionResponse, { authenticated: true }>> {
  // This switch is always initiated from the Settings page the caller is currently rendering, so
  // there is no need to blank the shell while the mutation is in flight -- see prepareTransition's
  // doc comment. Tearing down scoped queries/streams/overlays still happens immediately below.
  sessionRuntime.prepareTransition(undefined, { blank: false });
  try {
    const payload = await changePersona(userId, csrfToken);
    queryClient.setQueryData(queryKeys.session, payload.session);
    queryClient.setQueryData(queryKeys.csrf(payload.session.version), payload.csrfToken);
    sessionRuntime.broadcast('persona', payload.session.version);
    return payload.session;
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) {
      sessionRuntime.finishTransition();
      throw error;
    }
    return reconcileAmbiguousMutation(error);
  }
}

/** Logs out while clearing protected session state across the current browser context. */
export async function logoutSession(csrfToken: string): Promise<void> {
  sessionRuntime.prepareTransition();
  try {
    const payload = await endSession(csrfToken);
    queryClient.setQueryData(queryKeys.session, payload.session);
    queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[0] === 'csrf' });
    sessionRuntime.broadcast('logout');
  } catch (error) {
    return reconcileAmbiguousMutation(error);
  }
}

/** Restricts post-authentication navigation to safe application-relative destinations. */
export function safeDestination(value: string | null, fallback = '/deals'): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : fallback;
}

/** Reconciles the authoritative session after a mutation whose server outcome is uncertain. */
async function reconcileAmbiguousMutation(error: unknown): Promise<never> {
  try {
    const session = await sessionRuntime.reconcileAuthoritativeSession();
    if (!session.authenticated) {
      const returnTo = safeDestination(`${window.location.pathname}${window.location.search}`);
      window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    } else {
      window.location.reload();
    }
  } catch {
    window.location.reload();
  }
  throw error;
}

/** Determines whether two query keys identify the same cached resource. */
function sameQueryKey(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
}

/** Validates that a cross-tab message contains a supported session transition. */
function isSessionBroadcast(value: unknown): value is SessionBroadcast {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SessionBroadcast>;
  return (
    typeof candidate.source === 'string' &&
    (candidate.kind === 'persona' || candidate.kind === 'logout' || candidate.kind === 'invalidate')
  );
}
