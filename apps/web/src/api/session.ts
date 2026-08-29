import { QueryClient, queryOptions } from '@tanstack/react-query';
import type { AuthSessionResponse } from '@slacato/contracts';
import {
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

export const sessionQueryOptions = () => queryOptions({
  queryKey: queryKeys.session,
  queryFn: ({ signal }) => fetchSession(signal),
  staleTime: 0
});

export const personasQueryOptions = () => queryOptions({
  queryKey: queryKeys.personas,
  queryFn: ({ signal }) => fetchPersonas(signal),
  staleTime: 5 * 60_000
});

export const csrfQueryOptions = (version: string) => queryOptions({
  queryKey: queryKeys.csrf(version),
  queryFn: ({ signal }) => fetchCsrf(signal),
  staleTime: 0
});

export class SessionInvalidatedError extends Error {
  public constructor() {
    super('The signed session changed while protected data was loading.');
  }
}

export const diagnosticsQueryOptions = (version: string) => {
  const generation = sessionRuntime.generation;
  return queryOptions({
    queryKey: queryKeys.scoped(version, 'diagnostics'),
    retry: false,
    queryFn: async ({ signal }) => {
      const diagnostics = await fetchDiagnostics(signal);
      if (diagnostics.sessionVersion !== version || !sessionRuntime.accepts(generation)) {
        await sessionRuntime.reconcileAuthoritativeSession(queryKeys.scoped(version, 'diagnostics'));
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

class SessionRuntime {
  private readonly source = crypto.randomUUID();
  private readonly streams = new Set<ClosableStream>();
  private readonly overlayClosers = new Set<() => void>();
  private readonly channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('slacato-session');
  private connectionGeneration = 0;
  private transitionInProgress = false;
  private readonly transitionListeners = new Set<() => void>();

  public constructor() {
    this.channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (!isSessionBroadcast(event.data) || event.data.source === this.source) return;
      this.prepareTransition();
      queryClient.removeQueries({ queryKey: queryKeys.session });
      void this.resolveBroadcast(event.data.kind);
    });
  }

  public get generation(): number {
    return this.connectionGeneration;
  }

  public get transitioning(): boolean {
    return this.transitionInProgress;
  }

  public subscribe(listener: () => void): () => void {
    this.transitionListeners.add(listener);
    return () => this.transitionListeners.delete(listener);
  }

  public registerStream(stream: ClosableStream): () => void {
    this.streams.add(stream);
    return () => this.streams.delete(stream);
  }

  public registerOverlayCloser(close: () => void): () => void {
    this.overlayClosers.add(close);
    return () => this.overlayClosers.delete(close);
  }

  public accepts(generation: number): boolean {
    return generation === this.connectionGeneration;
  }

  public prepareTransition(preserveQueryKey?: readonly unknown[]): void {
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    this.connectionGeneration += 1;
    this.transitionInProgress = true;
    this.notifyTransition();
    for (const close of this.overlayClosers) close();
    this.overlayClosers.clear();
    const shouldTearDown = ({ queryKey }: { queryKey: readonly unknown[] }): boolean =>
      (queryKey[0] === 'scoped' || queryKey[0] === 'csrf') &&
      (preserveQueryKey === undefined || !sameQueryKey(queryKey, preserveQueryKey));
    void queryClient.cancelQueries({ predicate: shouldTearDown });
    queryClient.removeQueries({ predicate: shouldTearDown });
  }

  public finishTransition(): void {
    if (!this.transitionInProgress) return;
    this.transitionInProgress = false;
    this.notifyTransition();
  }

  public async reconcileAuthoritativeSession(preserveQueryKey?: readonly unknown[]): Promise<AuthSessionResponse> {
    this.prepareTransition(preserveQueryKey);
    queryClient.removeQueries({ queryKey: queryKeys.session });
    this.broadcast('invalidate');
    return queryClient.fetchQuery(sessionQueryOptions());
  }
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


  private notifyTransition(): void {
    for (const listener of this.transitionListeners) listener();
  }

  public broadcast(kind: SessionBroadcast['kind'], version?: string): void {
    this.channel?.postMessage({ source: this.source, kind, version } satisfies SessionBroadcast);
  }
}

export const sessionRuntime = new SessionRuntime();

export async function selectPersonaSession(userId: string, csrfToken: string): Promise<Extract<AuthSessionResponse, { authenticated: true }>> {
  sessionRuntime.prepareTransition();
  try {
    const payload = await changePersona(userId, csrfToken);
    queryClient.setQueryData(queryKeys.session, payload.session);
    queryClient.setQueryData(queryKeys.csrf(payload.session.version), payload.csrfToken);
    sessionRuntime.broadcast('persona', payload.session.version);
    return payload.session;
  } catch (error) {
    return reconcileAmbiguousMutation(error);
  }
}

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

export function safeDestination(value: string | null, fallback = '/deals'): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : fallback;
}

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

function sameQueryKey(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function isSessionBroadcast(value: unknown): value is SessionBroadcast {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SessionBroadcast>;
  return typeof candidate.source === 'string'
    && (candidate.kind === 'persona' || candidate.kind === 'logout' || candidate.kind === 'invalidate');
}
