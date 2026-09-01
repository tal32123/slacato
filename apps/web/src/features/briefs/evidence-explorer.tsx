import type { EvidenceDetail as EvidenceDetailView } from '@slacato/contracts';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { sessionRuntime } from '@/api/session';
import { EvidenceDetail } from './evidence-detail';

type EvidenceSelection = Readonly<{
  selectedEvidenceId: string | null;
  onEvidence: (evidenceId: string, trigger: HTMLButtonElement) => void;
}>;

/** Keeps evidence selection, history, focus, and responsive detail presentation consistent. */
export function EvidenceExplorer({
  evidence,
  children
}: Readonly<{
  evidence: readonly EvidenceDetailView[];
  children: (selection: EvidenceSelection) => ReactNode;
}>): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedId = searchParams.get('evidence');
  const selected = evidence.find((item) => item.id === selectedId);
  const selectedEvidenceId = selected?.id ?? null;
  const container = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const pushedEvidenceEntry = useRef(false);
  const [desktopEvidence, setDesktopEvidence] = useState(false);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = (): void =>
      setDesktopEvidence(
        window.matchMedia('(min-width: 1024px)').matches &&
          element.getBoundingClientRect().width >= 1_024
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
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
      className={
        desktopEvidence && selected !== undefined
          ? 'grid min-w-0 grid-cols-[minmax(640px,1fr)_clamp(360px,28vw,440px)] gap-6'
          : 'min-w-0'
      }
    >
      {children({ selectedEvidenceId, onEvidence: openEvidence })}
      {selected !== undefined && (
        <EvidenceDetail evidence={selected} desktop={desktopEvidence} onClose={closeEvidence} />
      )}
    </div>
  );
}
