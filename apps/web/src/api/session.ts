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

export const diagnosticsQueryOptions = (version: string) => queryOptions({
  queryKey: queryKeys.scoped(version, 'diagnostics'),
  queryFn: ({ signal }) => fetchDiagnostics(signal)
});

interface ClosableStream {
  close(): void;
}

type SessionBroadcast = Readonly<{
  source: string;
  kind: 'persona' | 'logout';
  version?: string;
}>;

class SessionRuntime {
  private readonly source = crypto.randomUUID();
  private readonly streams = new Set<ClosableStream>();
  private readonly overlayClosers = new Set<() => void>();
  private readonly channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('slacato-session');
  private connectionGeneration = 0;

  public constructor() {
    this.channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (!isSessionBroadcast(event.data) || event.data.source === this.source) return;
      this.prepareTransition();
      queryClient.removeQueries({ queryKey: queryKeys.session });
      if (event.data.kind === 'logout') window.location.replace('/login');
      else window.location.reload();
    });
  }

  public get generation(): number {
    return this.connectionGeneration;
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

  public prepareTransition(): void {
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    this.connectionGeneration += 1;
    for (const close of this.overlayClosers) close();
    this.overlayClosers.clear();
    void queryClient.cancelQueries({ predicate: ({ queryKey }) => queryKey[0] === 'scoped' || queryKey[0] === 'csrf' });
    queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[0] === 'scoped' || queryKey[0] === 'csrf' });
  }

  public broadcast(kind: SessionBroadcast['kind'], version?: string): void {
    this.channel?.postMessage({ source: this.source, kind, version } satisfies SessionBroadcast);
  }
}

export const sessionRuntime = new SessionRuntime();

export async function selectPersonaSession(userId: string, csrfToken: string): Promise<Extract<AuthSessionResponse, { authenticated: true }>> {
  sessionRuntime.prepareTransition();
  const payload = await changePersona(userId, csrfToken);
  queryClient.setQueryData(queryKeys.session, payload.session);
  queryClient.setQueryData(queryKeys.csrf(payload.session.version), payload.csrfToken);
  sessionRuntime.broadcast('persona', payload.session.version);
  return payload.session;
}

export async function logoutSession(csrfToken: string): Promise<void> {
  sessionRuntime.prepareTransition();
  const payload = await endSession(csrfToken);
  queryClient.setQueryData(queryKeys.session, payload.session);
  queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[0] === 'csrf' });
  sessionRuntime.broadcast('logout');
}

export function safeDestination(value: string | null, fallback = '/deals'): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : fallback;
}

function isSessionBroadcast(value: unknown): value is SessionBroadcast {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SessionBroadcast>;
  return typeof candidate.source === 'string' && (candidate.kind === 'persona' || candidate.kind === 'logout');
}
