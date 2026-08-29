import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Compass, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

const STORAGE_KEY = 'slacato.guided-tour.v1';
const TARGET_PADDING = 8;

type TourStep = Readonly<{
  target: string;
  route?: string;
  title: string;
  body: string;
}>;

const tourSteps: readonly TourStep[] = [
  {
    target: 'persona',
    title: 'Choose the active persona',
    body: 'Permissions shape every result. This menu shows who you are acting as and lets you switch roles deliberately.'
  },
  {
    target: 'nav-deals',
    route: '/deals',
    title: 'Start with authorized deals',
    body: 'Deals is the main workflow. The list is filtered at the data boundary for the active persona.'
  },
  {
    target: 'deal-list',
    route: '/deals',
    title: 'Open an opportunity workspace',
    body: 'Choose an accessible opportunity to inspect its CRM context, evidence, and generated strategy.'
  },
  {
    target: 'generate-brief',
    route: '/deals/OPP-1001',
    title: 'Generate the strategic brief',
    body: 'This starts retrieval and the agent workflow. The tour never clicks it for you, so generation only begins with your explicit action.'
  },
  {
    target: 'citations',
    route: '/deals/OPP-1001',
    title: 'Inspect grounded citations',
    body: 'Brief claims link back to authorized source excerpts, including the synthetic Slack corpus required by the assignment.'
  },
  {
    target: 'run-progress',
    route: '/runs',
    title: 'Follow durable run progress',
    body: 'Runs expose persisted workflow state and let you rejoin work at a stable URL instead of hiding execution in a spinner.'
  },
  {
    target: 'approvals',
    route: '/approvals',
    title: 'Review sensitive recommendations',
    body: 'Human approval gates keep pricing and legal decisions separate from the agents that prepare recommendations.'
  },
  {
    target: 'diagnostics',
    route: '/diagnostics',
    title: 'Verify the AI and retrieval setup',
    body: 'Diagnostics shows the configured OpenRouter generation model, embedding profile, index health, and permission facts.'
  }
];

type PersistedTour = Readonly<{ active: boolean; stepIndex: number }>;
type TargetBox = Readonly<{ top: number; left: number; width: number; height: number }>;

export function GuidedTour(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const initial = useRef(readTourState());
  const [active, setActive] = useState(initial.current.active);
  const [stepIndex, setStepIndex] = useState(initial.current.stepIndex);
  const [targetBox, setTargetBox] = useState<TargetBox>();
  const [targetMissing, setTargetMissing] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const step = tourSteps[stepIndex] ?? tourSteps[0]!;

  const close = useCallback((): void => {
    setActive(false);
    persistTourState({ active: false, stepIndex });
    window.requestAnimationFrame(() => launcherRef.current?.focus());
  }, [stepIndex]);

  const open = (): void => {
    setActive(true);
    persistTourState({ active: true, stepIndex });
  };

  const move = (nextIndex: number): void => {
    const bounded = Math.max(0, Math.min(tourSteps.length - 1, nextIndex));
    const nextStep = tourSteps[bounded]!;
    setStepIndex(bounded);
    persistTourState({ active: true, stepIndex: bounded });
    if (nextStep.route !== undefined && location.pathname !== nextStep.route) navigate(nextStep.route);
  };

  const finish = (): void => {
    setStepIndex(0);
    setActive(false);
    persistTourState({ active: false, stepIndex: 0 });
  };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') ?? [])];
        const first = controls[0];
        const last = controls.at(-1);
        if (!event.shiftKey && document.activeElement === last && first !== undefined) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first && last !== undefined) {
          event.preventDefault();
          last.focus();
        }
      }
      if (event.key === 'ArrowRight' && !event.metaKey && !event.ctrlKey) move(Math.min(stepIndex + 1, tourSteps.length - 1));
      if (event.key === 'ArrowLeft' && stepIndex > 0 && !event.metaKey && !event.ctrlKey) move(stepIndex - 1);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, close, stepIndex]);

  useEffect(() => {
    const start = (): void => open();
    window.addEventListener('slacato:start-guided-tour', start);
    return () => window.removeEventListener('slacato:start-guided-tour', start);
  });

  useLayoutEffect(() => {
    if (!active) return;
    let missingTimer: number | undefined;
    const updateTarget = (): void => {
      if (missingTimer !== undefined) {
        window.clearTimeout(missingTimer);
        missingTimer = undefined;
      }
      const candidates = [...document.querySelectorAll<HTMLElement>(`[data-tour="${step.target}"]`)];
      const target = candidates.find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }) ?? candidates[0] ?? null;
      document.querySelectorAll('[data-tour-active="true"]').forEach((element) => {
        if (element !== target) element.removeAttribute('data-tour-active');
      });
      if (target === null) {
        setTargetBox(undefined);
        missingTimer = window.setTimeout(() => setTargetMissing(true), 100);
        return;
      }
      if (target.getAttribute('data-tour-active') !== 'true') target.setAttribute('data-tour-active', 'true');
      target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      const rect = target.getBoundingClientRect();
      setTargetBox({
        top: Math.max(4, rect.top - TARGET_PADDING),
        left: Math.max(4, rect.left - TARGET_PADDING),
        width: Math.min(window.innerWidth - 8, rect.width + TARGET_PADDING * 2),
        height: Math.min(window.innerHeight - 8, rect.height + TARGET_PADDING * 2)
      });
      setTargetMissing(false);
    };
    const frame = window.requestAnimationFrame(updateTarget);
    const observer = new MutationObserver(updateTarget);
    const contentRoot = document.getElementById('main-content');
    if (contentRoot !== null) observer.observe(contentRoot, { childList: true, subtree: true });
    window.addEventListener('resize', updateTarget);
    window.addEventListener('scroll', updateTarget, true);
    return () => {
      window.cancelAnimationFrame(frame);
      if (missingTimer !== undefined) window.clearTimeout(missingTimer);
      observer.disconnect();
      window.removeEventListener('resize', updateTarget);
      window.removeEventListener('scroll', updateTarget, true);
      document.querySelectorAll('[data-tour-active="true"]').forEach((element) => element.removeAttribute('data-tour-active'));
    };
  }, [active, location.pathname, step.target]);

  useEffect(() => {
    if (active) nextRef.current?.focus();
  }, [active, location.pathname, stepIndex]);

  return (
    <>
      <Button
        ref={launcherRef}
        type="button"
        variant="secondary"
        className="fixed bottom-20 right-4 z-40 min-h-11 gap-2 rounded-full border border-primary/30 bg-card px-4 shadow-lg lg:bottom-5"
        onClick={open}
        aria-label={stepIndex > 0 ? 'Resume guided tour' : 'Start guided tour'}
        data-tour="tour-launcher"
      >
        <Compass aria-hidden="true" />
        <span className="hidden sm:inline">{stepIndex > 0 ? 'Resume tour' : 'Guided tour'}</span>
      </Button>

      {active && (
        <div className="fixed inset-0 z-[70]" aria-live="polite">
          {targetBox === undefined ? (
            <div className="absolute inset-0 bg-brand-forest/75 backdrop-blur-[1px]" />
          ) : (
            <Spotlight box={targetBox} />
          )}
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="guided-tour-title"
            className="fixed bottom-4 left-1/2 z-[72] w-[min(92vw,25rem)] -translate-x-1/2 rounded-2xl border border-primary/25 bg-card p-5 text-card-foreground shadow-2xl sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-primary">Step {stepIndex + 1} of {tourSteps.length}</p>
                <h2 id="guided-tour-title" className="mt-2 text-xl font-semibold tracking-tight">{step.title}</h2>
              </div>
              <Button type="button" size="icon" variant="ghost" aria-label="Close guided tour" onClick={close}><X aria-hidden="true" /></Button>
            </div>
            <Progress className="mt-4 h-1.5" value={((stepIndex + 1) / tourSteps.length) * 100} aria-label={`Tour step ${stepIndex + 1} of ${tourSteps.length}`} />
            <p className="mt-4 text-sm leading-6 text-muted-foreground">{step.body}</p>
            {targetMissing && <p role="status" className="mt-3 rounded-lg bg-attention/15 px-3 py-2 text-sm text-attention-foreground">This item is not available in the current view. You can continue safely.</p>}
            <div className="mt-5 flex items-center justify-between gap-3">
              <Button type="button" variant="ghost" onClick={close}>Skip tour</Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" disabled={stepIndex === 0} onClick={() => move(stepIndex - 1)}><ArrowLeft aria-hidden="true" />Back</Button>
                {stepIndex === tourSteps.length - 1 ? (
                  <Button ref={nextRef} type="button" onClick={finish}>Finish</Button>
                ) : (
                  <Button ref={nextRef} type="button" onClick={() => move(stepIndex + 1)}>Next<ArrowRight aria-hidden="true" /></Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Spotlight({ box }: Readonly<{ box: TargetBox }>): React.JSX.Element {
  const shadow = 'bg-brand-forest/75 backdrop-blur-[1px]';
  return (
    <>
      <div className={`fixed left-0 right-0 top-0 ${shadow}`} style={{ height: box.top }} />
      <div className={`fixed bottom-0 left-0 ${shadow}`} style={{ top: box.top, width: box.left }} />
      <div className={`fixed bottom-0 right-0 ${shadow}`} style={{ left: box.left + box.width, top: box.top }} />
      <div className={`fixed bottom-0 ${shadow}`} style={{ left: box.left, top: box.top + box.height, width: box.width }} />
      <div className="pointer-events-none fixed z-[71] rounded-xl ring-4 ring-primary ring-offset-4 ring-offset-background/80 shadow-[0_0_0_9999px_transparent]" style={box} />
    </>
  );
}

function readTourState(): PersistedTour {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<PersistedTour> | null;
    const stepIndex = typeof parsed?.stepIndex === 'number' && parsed.stepIndex >= 0 && parsed.stepIndex < tourSteps.length ? parsed.stepIndex : 0;
    return { active: parsed?.active === true, stepIndex };
  } catch {
    return { active: false, stepIndex: 0 };
  }
}

function persistTourState(state: PersistedTour): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The tour remains usable when storage is unavailable.
  }
}
