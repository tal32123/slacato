import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DealWorkspaceView } from '@slacato/contracts';
import type { LoaderFunctionArgs } from 'react-router';
import { useLoaderData, useNavigate, useSearchParams } from 'react-router';
import { queryClient, sessionQueryOptions, sessionRuntime, SessionInvalidatedError } from '@/api/session';
import { DealBrief } from '@/features/briefs/deal-brief';
import { EvidenceDetail } from '@/features/briefs/evidence-detail';
import { dealWorkspaceQueryOptions } from '@/features/deals/queries';
import { GenerateBriefAction } from '@/features/runs/generate-brief-action';
import { throwProtectedLoaderError } from './loader-security';

export async function dealLoader({ request, params }: LoaderFunctionArgs): Promise<DealWorkspaceView | null> {
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
          const workspace = await queryClient.fetchQuery(dealWorkspaceQueryOptions(session.version, opportunityId));
          sessionRuntime.finishTransition();
          return workspace;
        }
      } catch (retryError) { throwProtectedLoaderError(retryError, request); }
    }
    throwProtectedLoaderError(error, request);
  }
}

export function DealRoute(): React.JSX.Element {
  const workspace = useLoaderData() as DealWorkspaceView;
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedId = searchParams.get('evidence');
  const selected = workspace.evidence.find((item) => item.id === selectedId);
  const selectedEvidenceId = selected?.id ?? null;
  const container = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const pushedEvidenceEntry = useRef(false);
  const [desktopEvidence, setDesktopEvidence] = useState(false);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = (): void => setDesktopEvidence(window.matchMedia('(min-width: 1024px)').matches && element.getBoundingClientRect().width >= 1_024);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, []);

  useEffect(() => {
    if (selectedId !== null && selected === undefined) {
      pushedEvidenceEntry.current = false;
      const next = new URLSearchParams(searchParams);
      next.delete('evidence');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, selected, selectedId, setSearchParams]);

  const teardownEvidence = useCallback((): void => {
    pushedEvidenceEntry.current = false;
    const next = new URLSearchParams(searchParams);
    next.delete('evidence');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const closeEvidence = useCallback((): void => {
    if (pushedEvidenceEntry.current) {
      pushedEvidenceEntry.current = false;
      navigate(-1);
      return;
    }
    teardownEvidence();
  }, [navigate, teardownEvidence]);

  useEffect(() => {
    if (selectedEvidenceId !== null) {
      wasOpen.current = true;
      return sessionRuntime.registerOverlayCloser(teardownEvidence);
    }
    pushedEvidenceEntry.current = false;
    if (wasOpen.current) {
      wasOpen.current = false;
      requestAnimationFrame(() => returnFocus.current?.focus());
    }
  }, [selectedEvidenceId, teardownEvidence]);

  const openEvidence = (evidenceId: string, trigger: HTMLButtonElement): void => {
    returnFocus.current = trigger;
    if (selectedEvidenceId === null) pushedEvidenceEntry.current = true;
    const next = new URLSearchParams(searchParams);
    next.set('evidence', evidenceId);
    setSearchParams(next, { replace: selectedEvidenceId !== null });
  };

  return (
    <div
      ref={container}
      className={desktopEvidence && selected !== undefined ? 'grid min-w-0 grid-cols-[minmax(640px,1fr)_clamp(360px,28vw,440px)] gap-6' : 'min-w-0'}
    >
      <DealBrief
        workspace={workspace}
        selectedEvidenceId={selectedEvidenceId}
        onEvidence={openEvidence}
        primaryAction={<GenerateBriefAction opportunityId={workspace.deal.opportunityId} sessionVersion={workspace.sessionVersion} />}
      />
      {selected !== undefined && <EvidenceDetail evidence={selected} desktop={desktopEvidence} onClose={closeEvidence} />}
    </div>
  );
}
