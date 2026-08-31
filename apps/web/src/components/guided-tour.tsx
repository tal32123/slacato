import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Compass, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { readinessQueryOptions } from '@/api/session';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { describeGenerationReadiness } from '@/features/runs/generation-readiness';

const STORAGE_KEY = 'slacato.guided-tour.v2';
const START_EVENT = 'slacato:start-guided-tour';
const ADVANCE_EVENT = 'slacato:guided-tour-advance';
const TARGET_PADDING = 8;
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Lists the focusable elements inside a root, including the root itself when it qualifies. */
function collectFocusable(root: Element | null): HTMLElement[] {
  if (root === null) return [];
  const self = root.matches(FOCUSABLE_SELECTOR) ? [root as HTMLElement] : [];
  return [...self, ...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
}

type TourStep = Readonly<{
  target: string;
  route?: string;
  scenario: string;
  title: string;
  body: string;
  /** Instruction shown while the tour waits for the user to perform the step themselves. */
  waitingFor?: string;
  requiresInteraction?: boolean;
}>;

export const tourSteps: readonly [TourStep, ...TourStep[]] = [
  {
    target: 'login-personas',
    route: '/login',
    scenario: 'Scenario 1 · Authorized brief',
    title: 'Sign in as the deal owner',
    body: 'Every result in this product is shaped by who is asking. Choose Maya Levin: she owns opportunity OPP-1001, so she is allowed to see its evidence and ask for a brief.',
    waitingFor: 'Choose Maya Levin to continue.',
    requiresInteraction: true
  },
  {
    target: 'deal-list',
    route: '/deals',
    scenario: 'Scenario 1 · Authorized brief',
    title: 'Only the deals this person may see',
    body: 'This list is filtered by the server, not by the browser. Maya sees OPP-1001 and nothing else, because that is the only account her canonical permissions cover. Continue to open that workspace.'
  },
  {
    target: 'generate-brief',
    route: '/deals/OPP-1001',
    scenario: 'Scenario 1 · Authorized brief',
    title: 'Ask the agents for a strategic brief',
    body: 'Choose Generate Brief. The tour never presses it for you, because the whole point is that generation starts from a deliberate human request that the server re-authorizes.',
    waitingFor: 'Choose Generate Brief to continue.',
    requiresInteraction: true
  },
  {
    target: 'run-progress-detail',
    scenario: 'Scenario 1 · Authorized brief',
    title: 'Watch the work actually happen',
    body: 'Retrieval, specialists, synthesis, and validation each report their own state. This page has a stable address, so you can close the tab, come back, and rejoin the same run instead of losing it in a spinner. Wait for the run to finish before continuing.'
  },
  {
    target: 'citations',
    route: '/deals/OPP-1001',
    scenario: 'Scenario 1 · Authorized brief',
    title: 'Check the brief against its sources',
    body: 'Each claim carries citations back to the exact authorized record it came from. Select one to read the excerpt. Citations are re-authorized on open, so a citation can never become a side door into data the current persona may not read.'
  },
  {
    target: 'slack-evidence',
    route: '/deals/OPP-1001',
    scenario: 'Scenario 4 · Generated Slack updates',
    title: 'See the generated Slack updates change the answer',
    body: 'We added a reviewed, synthetic Slack channel of account-team updates to the supplied CRM, call, and pricing data. Source Evidence lists the Slack updates that were retrieved, and anything they changed is tagged "Account-team update impact" so you can tell what the chatter actually moved.'
  },
  {
    target: 'settings-personas',
    route: '/settings',
    scenario: 'Scenario 2 · Restricted deal and approvals',
    title: 'Switch to the restricted deal owner',
    body: 'Choose Nora Chen and apply the change. She owns OPP-1003, a restricted renewal with a steep discount, changed liability language, and a customer-facing concession. She is authorized for it; the next screens show what that unlocks and what it still gates.',
    waitingFor: 'Select Nora Chen and choose "Use selected persona" to continue.',
    requiresInteraction: true
  },
  {
    target: 'generate-brief',
    route: '/deals/OPP-1003',
    scenario: 'Scenario 2 · Restricted deal and approvals',
    title: 'Generate the restricted brief',
    body: 'Choose Generate Brief. Nora may read this deal, so retrieval succeeds. What she may not do is publish sensitive recommendations on her own, which is what the next screen is about.',
    waitingFor: 'Choose Generate Brief to continue.',
    requiresInteraction: true
  },
  {
    target: 'run-progress-detail',
    scenario: 'Scenario 2 · Restricted deal and approvals',
    title: 'The run stops instead of publishing',
    body: 'This run reaches "awaiting approval" rather than finishing. The discount, the liability wording, and the customer-facing concession each tripped a written policy rule, so the workflow parks the draft instead of releasing it. Wait for that state, then continue.'
  },
  {
    target: 'approvals',
    route: '/approvals',
    scenario: 'Scenario 2 · Restricted deal and approvals',
    title: 'Approval routing, split by authority',
    body: 'Every triggered rule becomes its own entry with its own eligible authority, and each entry shows quorum as "completed of required". Nora sees only the decisions she personally holds authority for, even on her own deal.'
  },
  {
    target: 'settings-personas',
    route: '/settings',
    scenario: 'Scenario 2 · Restricted deal and approvals',
    title: 'Now look through an approver’s eyes',
    body: 'Choose Rina Vale and apply the change. She is the Deal Desk approver for this account. Switching identity is the clearest way to show that the inbox is built from server-side authority, not from a client-side filter.',
    waitingFor: 'Select Rina Vale and choose "Use selected persona" to continue.',
    requiresInteraction: true
  },
  {
    target: 'approvals',
    route: '/approvals',
    scenario: 'Scenario 2 · Restricted deal and approvals',
    title: 'A different person, a different inbox',
    body: 'Rina sees the discount decision that is hers to make, and only that one. The legal wording waits for Iris Wynn and the deeper discount waits for Tomas Reed, so no single person can release the recommendation alone. Open her pending entry to make the decision.'
  },
  {
    target: 'approval-decision',
    scenario: 'Scenario 2 · Restricted deal and approvals',
    title: 'Record a real human decision',
    body: 'Approve unchanged, edit and approve, or reject with a reason. The decision is bound to the exact brief snapshot and run version you are looking at, so it cannot silently land on different content. Quorum still needs the other authorities, so the run stays parked until they decide too.',
    waitingFor: 'Record your Deal Desk decision to continue.',
    requiresInteraction: true
  },
  {
    target: 'settings-personas',
    route: '/settings',
    scenario: 'Scenario 3 · Unauthorized attempt',
    title: 'Switch to someone with no access',
    body: 'Choose Harper Noor and apply the change. Harper is a genuine fixture identity with no permission on the restricted account. The next two screens show exactly what she can and cannot learn.',
    waitingFor: 'Select Harper Noor and choose "Use selected persona" to continue.',
    requiresInteraction: true
  },
  {
    target: 'deal-list',
    route: '/deals',
    scenario: 'Scenario 3 · Unauthorized attempt',
    title: 'The restricted deal simply is not there',
    body: 'Harper’s list contains no row, no name, no account, and no count for the restricted deal. Nothing about it was retrieved, summarized, or cited, so there is nothing on this page to redact.'
  },
  {
    target: 'denial-notice',
    route: '/deals/OPP-1003',
    scenario: 'Scenario 3 · Unauthorized attempt',
    title: 'A direct link gives nothing away',
    body: 'The tour just requested the restricted deal by its address. The answer is a single opaque refusal: no deal name, no account, no evidence, no hint that the record exists at all. The denial is still audited on the server.'
  },
  {
    target: 'diagnostics',
    route: '/diagnostics',
    scenario: 'Wrap-up · Verify the setup',
    title: 'Verify the setup for yourself',
    body: 'Diagnostics reports the live generation model, the embedding profile, index health, and the permission facts behind the boundaries you just watched. Choose Finish, then use Settings to return to any persona.'
  }
];

type PersistedTour = Readonly<{ active: boolean; stepIndex: number; dismissed: boolean }>;
type TargetBox = Readonly<{ top: number; left: number; width: number; height: number }>;

/** Guides users through an interactive tour anchored to the product controls they need next. */
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
  const routedStep = useRef<number | undefined>(undefined);
  /** The live page element the spotlight currently frames, so a required-interaction step's focus
   * trap can admit it -- the one piece of "background" the user must still be able to reach. */
  const targetElRef = useRef<HTMLElement | null>(null);
  const step = tourSteps[stepIndex] ?? tourSteps[0];
  // Only checked while a step actually waits on Generate Brief, so the tour never polls
  // readiness for the steps that have nothing to do with it.
  const readiness = useQuery({
    ...readinessQueryOptions(),
    enabled: active && step.target === 'generate-brief'
  });
  const generationGate =
    step.target === 'generate-brief'
      ? describeGenerationReadiness(readiness.data, readiness.isError)
      : { blocked: false };

  const settle = useCallback((nextIndex: number): void => {
    const safe = Number.isFinite(nextIndex) ? Math.round(nextIndex) : 0;
    const bounded = Math.max(0, Math.min(tourSteps.length - 1, safe));
    routedStep.current = undefined;
    setStepIndex(bounded);
    persistTourState({ active: true, stepIndex: bounded, dismissed: false });
  }, []);

  const close = useCallback((): void => {
    setActive(false);
    persistTourState({ active: false, stepIndex, dismissed: true });
    window.requestAnimationFrame(() => launcherRef.current?.focus());
  }, [stepIndex]);

  const open = useCallback((): void => {
    setActive(true);
    settle(0);
  }, [settle]);

  const move = useCallback(
    (nextIndex: number): void => {
      if (step.requiresInteraction === true && nextIndex > stepIndex) return;
      settle(nextIndex);
    },
    [settle, step.requiresInteraction, stepIndex]
  );

  const finish = (): void => {
    setStepIndex(0);
    setActive(false);
    routedStep.current = undefined;
    persistTourState({ active: false, stepIndex: 0, dismissed: true });
  };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        // The trap always covers the dialog's own controls. On a step that requires acting on
        // the real page, it also admits whatever the spotlight currently frames -- that target is
        // the one piece of "background" the user must still be able to reach -- but nothing else:
        // every other background control (other persona cards, disclosures, the tour launcher
        // itself) stays out of reach, matching what the spotlight already blocks by mouse.
        const controls = [
          ...collectFocusable(dialogRef.current),
          ...(step.requiresInteraction === true ? collectFocusable(targetElRef.current) : [])
        ];
        if (controls.length > 0) {
          event.preventDefault();
          const current = controls.indexOf(document.activeElement as HTMLElement);
          const size = controls.length;
          const nextIndex =
            current === -1 ? 0 : event.shiftKey ? (current - 1 + size) % size : (current + 1) % size;
          controls[nextIndex]?.focus();
        }
      }
      if (
        event.key === 'ArrowRight' &&
        step.requiresInteraction !== true &&
        !event.metaKey &&
        !event.ctrlKey
      )
        move(Math.min(stepIndex + 1, tourSteps.length - 1));
      if (event.key === 'ArrowLeft' && stepIndex > 0 && !event.metaKey && !event.ctrlKey)
        move(stepIndex - 1);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, close, move, step.requiresInteraction, stepIndex]);

  useEffect(() => {
    const start = (): void => open();
    const advance = (event: Event): void => {
      const detail = (event as CustomEvent<{ stepIndex?: unknown }>).detail;
      if (typeof detail?.stepIndex !== 'number' || !Number.isFinite(detail.stepIndex)) return;
      setActive(true);
      settle(detail.stepIndex);
    };
    window.addEventListener(START_EVENT, start);
    window.addEventListener(ADVANCE_EVENT, advance);
    return () => {
      window.removeEventListener(START_EVENT, start);
      window.removeEventListener(ADVANCE_EVENT, advance);
    };
  }, [open, settle]);

  // Each step routes itself once, so a redirected denial never loops and manual detours stay visible.
  useEffect(() => {
    if (!active || step.route === undefined || routedStep.current === stepIndex) return;
    routedStep.current = stepIndex;
    if (location.pathname !== step.route) void navigate(step.route);
  }, [active, location.pathname, navigate, step.route, stepIndex]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Route changes must reposition the tour target.
  useLayoutEffect(() => {
    if (!active) return;
    let missingTimer: number | undefined;
    let targetFocusPlaced = false;
    const updateTarget = (): void => {
      if (missingTimer !== undefined) {
        window.clearTimeout(missingTimer);
        missingTimer = undefined;
      }
      const candidates = [
        ...document.querySelectorAll<HTMLElement>(`[data-tour="${step.target}"]`)
      ];
      const target =
        candidates.find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }) ??
        candidates[0] ??
        null;
      document.querySelectorAll('[data-tour-active="true"]').forEach((element) => {
        if (element !== target) element.removeAttribute('data-tour-active');
      });
      if (target === null) {
        targetElRef.current = null;
        setTargetBox(undefined);
        missingTimer = window.setTimeout(() => setTargetMissing(true), 100);
        return;
      }
      targetElRef.current = target;
      if (target.getAttribute('data-tour-active') !== 'true')
        target.setAttribute('data-tour-active', 'true');
      target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      if (step.requiresInteraction === true && !targetFocusPlaced) {
        const interactive = collectFocusable(target)[0];
        interactive?.focus();
        targetFocusPlaced = interactive !== undefined;
      }
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
    const contentRoot = document.getElementById('main-content') ?? document.body;
    observer.observe(contentRoot, { childList: true, subtree: true });
    window.addEventListener('resize', updateTarget);
    window.addEventListener('scroll', updateTarget, true);
    return () => {
      window.cancelAnimationFrame(frame);
      if (missingTimer !== undefined) window.clearTimeout(missingTimer);
      observer.disconnect();
      window.removeEventListener('resize', updateTarget);
      window.removeEventListener('scroll', updateTarget, true);
      document.querySelectorAll('[data-tour-active="true"]').forEach((element) => {
        element.removeAttribute('data-tour-active');
      });
      targetElRef.current = null;
    };
  }, [active, location.pathname, step.requiresInteraction, step.target]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Route and step changes must refocus tour controls.
  useEffect(() => {
    if (active && step.requiresInteraction !== true) nextRef.current?.focus();
  }, [active, location.pathname, step.requiresInteraction, stepIndex]);

  const offPath = targetMissing && step.route !== undefined && location.pathname !== step.route;
  // Anchor the dialog to whichever half of the viewport the spotlighted target is NOT in, so a
  // target near the top of a short or narrow page -- the login persona cards on a phone, for
  // instance -- is never covered by the very tooltip explaining it. Without a target yet, fall
  // back to the prior default: interactive steps float near the top, everything else near the
  // bottom.
  const targetInLowerHalf =
    targetBox !== undefined && targetBox.top + targetBox.height / 2 > window.innerHeight / 2;
  const placement =
    targetBox === undefined
      ? step.requiresInteraction === true
        ? 'top-4'
        : 'bottom-4'
      : targetInLowerHalf
        ? 'top-4'
        : 'bottom-4';

  return (
    <>
      <Button
        ref={launcherRef}
        type="button"
        variant="secondary"
        className="fixed bottom-20 right-4 z-40 min-h-11 min-w-11 gap-2 rounded-full border border-primary/30 bg-card px-4 shadow-lg lg:bottom-5"
        onClick={open}
        aria-label="Start guided tour"
        data-tour="tour-launcher"
      >
        <Compass aria-hidden="true" />
        <span className="hidden sm:inline">Guided tour</span>
      </Button>

      {active && (
        <div className="pointer-events-none fixed inset-0 z-[70]" aria-live="polite">
          {targetBox === undefined ? (
            <div className="pointer-events-auto absolute inset-0 bg-brand-forest/75 backdrop-blur-[1px]" />
          ) : (
            <Spotlight box={targetBox} />
          )}
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal={step.requiresInteraction === true ? undefined : true}
            aria-labelledby="guided-tour-title"
            aria-describedby="guided-tour-description"
            className={`pointer-events-auto fixed left-1/2 z-[72] max-h-[calc(100dvh-2rem)] w-[min(92vw,25rem)] overflow-y-auto -translate-x-1/2 rounded-2xl border border-primary/25 bg-card p-5 text-card-foreground shadow-2xl sm:p-6 ${placement}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-primary">
                  Step {stepIndex + 1} of {tourSteps.length}
                </p>
                <p className="mt-1 text-xs font-medium text-muted-foreground">{step.scenario}</p>
                <h2 id="guided-tour-title" className="mt-2 text-xl font-semibold tracking-tight">
                  {step.title}
                </h2>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Close guided tour"
                onClick={close}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <Progress
              className="mt-4 h-1.5"
              value={((stepIndex + 1) / tourSteps.length) * 100}
              aria-label={`Tour step ${stepIndex + 1} of ${tourSteps.length}`}
            />
            <p
              id="guided-tour-description"
              className="mt-4 text-sm leading-6 text-muted-foreground"
            >
              {step.body}
            </p>
            {targetMissing && (
              <div
                role="status"
                className="mt-3 rounded-lg bg-attention/15 px-3 py-2 text-sm text-attention-foreground"
              >
                <p>
                  {offPath
                    ? 'You have stepped off the guided path. Return to this step, or leave the tour.'
                    : 'This step is not ready on screen yet. Wait for it to load, or move on.'}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {step.route !== undefined && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        routedStep.current = undefined;
                        setTargetMissing(false);
                        if (step.route !== undefined) void navigate(step.route);
                      }}
                    >
                      Return to this step
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => settle(stepIndex + 1)}
                  >
                    Continue anyway
                  </Button>
                </div>
              </div>
            )}
            {!targetMissing && generationGate.blocked && (
              <div
                role="status"
                className="mt-3 rounded-lg bg-attention/15 px-3 py-2 text-sm text-attention-foreground"
              >
                <p>
                  Generate Brief is disabled right now, so this step cannot be completed as
                  written: {generationGate.reason}
                </p>
              </div>
            )}
            <div className="mt-5 flex items-center justify-between gap-3">
              <Button type="button" variant="ghost" onClick={close}>
                Skip tour
              </Button>
              {step.requiresInteraction === true ? (
                generationGate.blocked ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => settle(Math.min(stepIndex + 1, tourSteps.length - 1))}
                  >
                    Continue without generating
                    <ArrowRight aria-hidden="true" />
                  </Button>
                ) : (
                  <p className="text-right text-sm font-medium text-primary">
                    {step.waitingFor ?? 'Complete this action to continue.'}
                  </p>
                )
              ) : (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={stepIndex === 0}
                    onClick={() => move(stepIndex - 1)}
                  >
                    <ArrowLeft aria-hidden="true" />
                    Back
                  </Button>
                  {stepIndex === tourSteps.length - 1 ? (
                    <Button ref={nextRef} type="button" onClick={finish}>
                      Finish
                    </Button>
                  ) : (
                    <Button ref={nextRef} type="button" onClick={() => move(stepIndex + 1)}>
                      Next
                      <ArrowRight aria-hidden="true" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Offers the guided tour on arrival so a reviewer either follows it or skips it deliberately. */
export function GuidedTourInvitation(): React.JSX.Element | null {
  const [visible, setVisible] = useState(() => {
    const state = readTourState();
    return !state.active && !state.dismissed;
  });
  if (!visible) return null;
  return (
    <section
      aria-labelledby="guided-tour-invitation-title"
      className="mb-8 rounded-2xl border border-primary/30 bg-primary/5 p-5 sm:p-6"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-primary">
        Guided demo · {tourSteps.length} steps
      </p>
      <h2 id="guided-tour-invitation-title" className="mt-2 text-xl font-semibold tracking-tight">
        Take the guided tour instead of exploring blind
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        The tour walks the four assignment scenarios in order: an authorized brief, a restricted
        deal with approval routing, an unauthorized attempt that leaks nothing, and the generated
        Slack updates that changed the answer. It waits for you at each real action, and you can
        leave it at any point.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button
          type="button"
          className="min-h-11"
          onClick={() => {
            setVisible(false);
            window.dispatchEvent(new Event(START_EVENT));
          }}
        >
          Start the guided tour
          <ArrowRight aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={() => {
            persistTourState({ ...readTourState(), active: false, dismissed: true });
            setVisible(false);
          }}
        >
          Skip the tour
        </Button>
      </div>
    </section>
  );
}

/** Dims the page around the current tour target so the next interaction is visually clear. */
function Spotlight({ box }: Readonly<{ box: TargetBox }>): React.JSX.Element {
  const shadow = 'pointer-events-auto bg-brand-forest/75 backdrop-blur-[1px]';
  return (
    <>
      <div className={`fixed left-0 right-0 top-0 ${shadow}`} style={{ height: box.top }} />
      <div
        className={`fixed bottom-0 left-0 ${shadow}`}
        style={{ top: box.top, width: box.left }}
      />
      <div
        className={`fixed bottom-0 right-0 ${shadow}`}
        style={{ left: box.left + box.width, top: box.top }}
      />
      <div
        className={`fixed bottom-0 ${shadow}`}
        style={{ left: box.left, top: box.top + box.height, width: box.width }}
      />
      <div
        className="pointer-events-none fixed z-[71] rounded-xl ring-4 ring-primary ring-offset-4 ring-offset-background/80 shadow-[0_0_0_9999px_transparent]"
        style={box}
      />
    </>
  );
}

/** Advances an active tour when the user completes the action the current step waits for. */
export function advanceGuidedTour(completedTarget: string): boolean {
  const state = readTourState();
  const current = tourSteps[state.stepIndex];
  if (!state.active || current === undefined || current.target !== completedTarget) return false;
  const stepIndex = Math.min(state.stepIndex + 1, tourSteps.length - 1);
  persistTourState({ active: true, stepIndex, dismissed: false });
  window.dispatchEvent(new CustomEvent(ADVANCE_EVENT, { detail: { stepIndex } }));
  return true;
}

/** Advances an active tour after a successful sign-in and reports whether it changed. */
export function advanceGuidedTourFromLogin(): boolean {
  return advanceGuidedTour('login-personas');
}

/** Restores a valid guided-tour position from this browser. */
function readTourState(): PersistedTour {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? 'null'
    ) as Partial<PersistedTour> | null;
    const stepIndex =
      typeof parsed?.stepIndex === 'number' &&
      Number.isInteger(parsed.stepIndex) &&
      parsed.stepIndex >= 0 &&
      parsed.stepIndex < tourSteps.length
        ? parsed.stepIndex
        : 0;
    return { active: parsed?.active === true, stepIndex, dismissed: parsed?.dismissed === true };
  } catch {
    return { active: false, stepIndex: 0, dismissed: false };
  }
}

/** Saves the current guided-tour position in this browser when storage is available. */
function persistTourState(state: PersistedTour): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The tour remains usable when storage is unavailable.
  }
}
