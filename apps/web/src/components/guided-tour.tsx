import type { DemoSession, RunDetailResponse, RunStatus } from '@slacato/contracts';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Compass, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useRouteLoaderData } from 'react-router';
import { readinessQueryOptions } from '@/api/session';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { describeGenerationReadiness } from '@/features/runs/generation-readiness';
import { runDetailQueryOptions } from '@/features/runs/queries';

const STORAGE_KEY = 'slacato.guided-tour.v3';
const START_EVENT = 'slacato:start-guided-tour';
const ADVANCE_EVENT = 'slacato:guided-tour-advance';
const TARGET_PADDING = 8;
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Run outcomes that end a run without reaching the state a step narrates. */
const UNSUCCESSFUL_RUN_STATUSES: readonly RunStatus[] = ['failed', 'cancelled', 'rejected'];
const RUN_PATH_PATTERN = /^\/runs\/([^/]+)$/;

/** Renders a run status as the plain words the interface uses elsewhere. */
function readableRunStatus(status: RunStatus): string {
  return status.replace(/_/g, ' ');
}

type RunGate = Readonly<{ waiting: boolean; notice?: string }>;

/**
 * Decides whether a run-narrating step must hold, and what to tell the user while it does.
 * A step never holds on a run that has stopped: an unreadable state, a failure, a cancellation
 * and a rejection all release the tour with an honest note, because a user who cannot advance
 * and cannot see why is stuck in a product that looks broken.
 */
function describeRunGate(
  expected: readonly RunStatus[] | undefined,
  detail: RunDetailResponse | undefined,
  failed: boolean
): RunGate {
  if (expected === undefined) return { waiting: false };
  if (failed)
    return {
      waiting: false,
      notice: 'This run’s live state could not be read, so the tour is not holding you here.'
    };
  if (detail === undefined) return { waiting: true, notice: 'Checking this run’s state…' };
  if (expected.includes(detail.status)) return { waiting: false };
  if (UNSUCCESSFUL_RUN_STATUSES.includes(detail.status))
    return {
      waiting: false,
      notice: `This run ended as "${readableRunStatus(detail.status)}" instead of "${readableRunStatus(expected[0] as RunStatus)}". You can continue, but the next steps describe a run that reached that state.`
    };
  return {
    waiting: true,
    notice: `Waiting for this run to reach "${readableRunStatus(expected[0] as RunStatus)}" — it is ${readableRunStatus(detail.status)} right now.`
  };
}

/** Lists the focusable elements inside a root, including the root itself when it qualifies. */
function collectFocusable(root: Element | null): HTMLElement[] {
  if (root === null) return [];
  const self = root.matches(FOCUSABLE_SELECTOR) ? [root as HTMLElement] : [];
  return [...self, ...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
}

type TourStep = Readonly<{
  /** The single page element the spotlight frames -- the one control the step asks the user to act on. */
  target: string;
  route?: string;
  scenario: string;
  title: string;
  body: string;
  /** Instruction shown while the tour waits for the user to perform the step themselves. */
  waitingFor?: string;
  requiresInteraction?: boolean;
  /**
   * The action key `advanceGuidedTour` matches for this step, when it differs from `target`.
   * Targets name a DOM element and change whenever the spotlight is narrowed; action keys name a
   * completed product action and belong to the call sites that report one, so the two are kept
   * separate rather than tied together by a shared string.
   */
  action?: string;
  /**
   * Run states that release this step. While the user is on a run page and the run has reached
   * none of them, the step holds instead of letting the user walk past work still in progress.
   */
  awaitRunStatus?: readonly RunStatus[];
  /**
   * Recognises the navigation this step's own body invites. Following an instruction is never
   * "stepping off the guided path", so a matching route advances the tour instead of warning.
   */
  advanceOnPath?: (pathname: string) => boolean;
}>;

export const tourSteps: readonly [TourStep, ...TourStep[]] = [
  {
    target: 'persona-USR-5001',
    action: 'login-personas',
    route: '/login',
    scenario: 'Scenario 1 \u00b7 Authorized brief',
    title: 'Sign in as the deal owner',
    body: 'Every result in this product is shaped by who is asking. The spotlight is on Maya Levin: she owns opportunity OPP-1001, so she is allowed to see its evidence and ask for a brief.',
    waitingFor: 'Choose "Continue as Maya Levin" to continue.',
    requiresInteraction: true
  },
  {
    target: 'deal-list',
    route: '/deals',
    scenario: 'Scenario 1 \u00b7 Authorized brief',
    title: 'Only the deals this person may see',
    body: 'This list is filtered by the server, not by the browser. Maya sees OPP-1001 and nothing else, because that is the only account her canonical permissions cover. Open that workspace, or choose Next.',
    advanceOnPath: (pathname) => pathname === '/deals/OPP-1001'
  },
  {
    target: 'generate-brief',
    route: '/deals/OPP-1001',
    scenario: 'Scenario 1 \u00b7 Authorized brief',
    title: 'Ask the agents for a strategic brief',
    body: 'Choose Generate Brief. The tour never presses it for you, because the whole point is that generation starts from a deliberate human request that the server re-authorizes.',
    waitingFor: 'Choose Generate Brief to continue.',
    requiresInteraction: true
  },
  {
    target: 'run-progress-detail',
    scenario: 'Scenario 1 \u00b7 Authorized brief',
    title: 'Watch the work actually happen',
    body: 'Retrieval, specialists, synthesis, and validation each report their own state. This page has a stable address, so you can close the tab, come back, and rejoin the same run instead of losing it in a spinner.',
    awaitRunStatus: ['completed']
  },
  {
    target: 'citations',
    route: '/deals/OPP-1001',
    scenario: 'Scenario 1 \u00b7 Authorized brief',
    title: 'Check the brief against its sources',
    body: 'Each claim carries citations back to the exact authorized record it came from. Select one to read the excerpt. Citations are re-authorized on open, so a citation can never become a side door into data the current persona may not read.'
  },
  {
    target: 'slack-evidence',
    route: '/deals/OPP-1001',
    scenario: 'Scenario 4 \u00b7 Generated Slack updates',
    title: 'See the generated Slack updates change the answer',
    body: 'We added a reviewed, synthetic Slack channel of account-team updates to the supplied CRM, call, and pricing data. Source Evidence lists the Slack updates that were retrieved, and anything they changed is tagged "Account-team update impact" so you can tell what the chatter actually moved.'
  },
  {
    target: 'persona-USR-5003',
    action: 'persona-selected:USR-5003',
    route: '/settings',
    scenario: 'Scenario 2 \u00b7 Restricted deal and approvals',
    title: 'Select the restricted deal owner',
    body: 'Nora Chen owns OPP-1003, a restricted renewal with a steep discount, changed liability language, and a customer-facing concession. She is authorized for it; the next screens show what that unlocks and what it still gates.',
    waitingFor: 'Select Nora Chen to continue.',
    requiresInteraction: true
  },
  {
    target: 'settings-apply-persona',
    action: 'settings-personas',
    route: '/settings',
    scenario: 'Scenario 2 \u00b7 Restricted deal and approvals',
    title: 'Apply the persona change',
    body: 'Switching persona closes open views and live connections before any protected data is reloaded, so nothing from the previous identity survives the change.',
    waitingFor: 'Choose "Use selected persona" to continue.',
    requiresInteraction: true
  },
  {
    target: 'generate-brief',
    route: '/deals/OPP-1003',
    scenario: 'Scenario 2 \u00b7 Restricted deal and approvals',
    title: 'Generate the restricted brief',
    body: 'Choose Generate Brief. Nora may read this deal, so retrieval succeeds. What she may not do is publish sensitive recommendations on her own, which is what the next screen is about.',
    waitingFor: 'Choose Generate Brief to continue.',
    requiresInteraction: true
  },
  {
    target: 'run-progress-detail',
    scenario: 'Scenario 2 \u00b7 Restricted deal and approvals',
    title: 'The run stops instead of publishing',
    body: 'This run reaches "awaiting approval" rather than finishing. The discount, the liability wording, and the customer-facing concession each tripped a written policy rule, so the workflow parks the draft instead of releasing it.',
    awaitRunStatus: ['awaiting_approval']
  },
  {
    target: 'approvals',
    route: '/approvals',
    scenario: 'Scenario 2 \u00b7 Restricted deal and approvals',
    title: 'Approval routing, split by authority',
    body: 'Every triggered rule becomes its own entry with its own eligible authority, and each entry shows quorum as "completed of required". Nora sees only the decisions she personally holds authority for, even on her own deal.'
  },
  {
    target: 'persona-USR-5005',
    action: 'persona-selected:USR-5005',
    route: '/settings',
    scenario: 'Scenario 2 \u00b7 Restricted deal and approvals',
    title: 'Now look through an approver\u2019s eyes',
    body: 'Rina Vale is the Deal Desk approver for this account. Switching identity is the clearest way to show that the inbox is built from server-side authority, not from a client-side filter.',
    waitingFor: 'Select Rina Vale to continue.',
    requiresInteraction: true
  },
  {
    target: 'settings-apply-persona',
    action: 'settings-personas',
    route: '/settings',
    scenario: 'Scenario 2 \u00b7 Restricted deal and approvals',
    title: 'Apply the persona change',
    body: 'The same teardown runs again. Nothing Nora could read is carried into Rina\u2019s session; the approvals inbox you are about to see is rebuilt from Rina\u2019s own authority.',
    waitingFor: 'Choose "Use selected persona" to continue.',
    requiresInteraction: true
  },
  {
    target: 'approvals',
    route: '/approvals',
    scenario: 'Scenario 2 \u00b7 Restricted deal and approvals',
    title: 'A different person, a different inbox',
    body: 'Rina sees the discount decision that is hers to make, and only that one. The legal wording waits for Iris Wynn and the deeper discount waits for Tomas Reed, so no single person can release the recommendation alone. Open her pending entry to make the decision.',
    advanceOnPath: (pathname) => pathname.startsWith('/approvals/')
  },
  {
    target: 'approval-decision',
    scenario: 'Scenario 2 \u00b7 Restricted deal and approvals',
    title: 'Record a real human decision',
    body: 'Approve unchanged, edit and approve, or reject with a reason. The decision is bound to the exact brief snapshot and run version you are looking at, so it cannot silently land on different content. Quorum still needs the other authorities, so the run stays parked until they decide too.',
    waitingFor: 'Record your Deal Desk decision to continue.',
    requiresInteraction: true
  },
  {
    target: 'persona-USR-5007',
    action: 'persona-selected:USR-5007',
    route: '/settings',
    scenario: 'Scenario 3 \u00b7 Unauthorized attempt',
    title: 'Select someone with no access',
    body: 'Harper Noor is a genuine fixture identity with no permission on the restricted account. The next two screens show exactly what she can and cannot learn.',
    waitingFor: 'Select Harper Noor to continue.',
    requiresInteraction: true
  },
  {
    target: 'settings-apply-persona',
    action: 'settings-personas',
    route: '/settings',
    scenario: 'Scenario 3 \u00b7 Unauthorized attempt',
    title: 'Apply the persona change',
    body: 'Harper signs in exactly as the other personas did. Nothing about the request changes -- only the identity behind it, which is the whole variable this scenario tests.',
    waitingFor: 'Choose "Use selected persona" to continue.',
    requiresInteraction: true
  },
  {
    target: 'deal-list',
    route: '/deals',
    scenario: 'Scenario 3 \u00b7 Unauthorized attempt',
    title: 'The restricted deal simply is not there',
    body: 'Harper\u2019s list contains no row, no name, no account, and no count for the restricted deal. Nothing about it was retrieved, summarized, or cited, so there is nothing on this page to redact.'
  },
  {
    target: 'denial-notice',
    route: '/deals/OPP-1003',
    scenario: 'Scenario 3 \u00b7 Unauthorized attempt',
    title: 'A direct link gives nothing away',
    body: 'The tour just requested the restricted deal by its address. The answer is a single opaque refusal: no deal name, no account, no evidence, no hint that the record exists at all. The denial is still audited on the server.'
  },
  {
    target: 'diagnostics',
    route: '/diagnostics',
    scenario: 'Wrap-up \u00b7 Verify the setup',
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

  // Steps that narrate a run read that run's live state rather than trusting the user to judge
  // when the work is done. The watcher below is mounted only while such a step is on a run page,
  // so the tour registers no query observers on any other screen: an always-present observer on a
  // session-scoped key interferes with the protected route loaders, which tear those keys down
  // and re-fetch around every session transition.
  const runId = RUN_PATH_PATTERN.exec(location.pathname)?.[1];
  const awaitsRun = active && step.awaitRunStatus !== undefined && runId !== undefined;
  const [watchedGate, setWatchedGate] = useState<RunGate>({ waiting: false });
  const runGate = awaitsRun ? watchedGate : { waiting: false };

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
      if (runGate.waiting && nextIndex > stepIndex) return;
      settle(nextIndex);
    },
    [runGate.waiting, settle, step.requiresInteraction, stepIndex]
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
            current === -1
              ? 0
              : event.shiftKey
                ? (current - 1 + size) % size
                : (current + 1) % size;
          controls[nextIndex]?.focus();
        }
      }
      if (
        event.key === 'ArrowRight' &&
        step.requiresInteraction !== true &&
        !runGate.waiting &&
        !event.metaKey &&
        !event.ctrlKey
      )
        move(Math.min(stepIndex + 1, tourSteps.length - 1));
      if (event.key === 'ArrowLeft' && stepIndex > 0 && !event.metaKey && !event.ctrlKey)
        move(stepIndex - 1);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, close, move, runGate.waiting, step.requiresInteraction, stepIndex]);

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

  // A step whose body invites a navigation ("open that workspace", "open her pending entry")
  // must treat that navigation as progress. Without this the target disappears, the tour decides
  // the user wandered off, and it accuses them of leaving the path they were just told to follow.
  // Only fires after this step has routed itself, so arriving at a matching address by some other
  // route -- a deep link, a reload -- does not skip the step the user has not seen yet.
  useEffect(() => {
    if (!active || step.advanceOnPath === undefined) return;
    if (routedStep.current !== stepIndex || location.pathname === step.route) return;
    if (!step.advanceOnPath(location.pathname)) return;
    settle(Math.min(stepIndex + 1, tourSteps.length - 1));
  }, [active, location.pathname, settle, step.advanceOnPath, step.route, stepIndex]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Route changes must reposition the tour target.
  useLayoutEffect(() => {
    if (!active) return;
    let missingTimer: number | undefined;
    let targetFocusPlaced = false;
    // Tracks which element we have already scrolled into view for this step. `updateTarget` also
    // runs from the 'scroll' listener below (so the spotlight keeps tracking its target while the
    // page scrolls) and from a MutationObserver on the content root -- both fire during and
    // because of the very `scrollIntoView` call below. Re-issuing `scrollIntoView` on every one of
    // those re-entrant calls fights any scroll a user or test performs on a nested element (e.g.
    // Playwright bringing a specific control into view before clicking it): each fight restarts
    // the smooth-scroll and moves the target underneath the pointer, so the element never settles.
    // Scrolling only when the resolved target element actually changes keeps the initial reveal
    // while letting subsequent scrolls (from any source) stand.
    let scrolledTarget: Element | null = null;
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
      if (scrolledTarget !== target) {
        // `behavior: 'auto'` (instant), not 'smooth': an animated reveal keeps the target's
        // on-screen position changing for several hundred ms after this call returns. A user (or
        // Playwright) who tries to act on the target during that window sees it move out from
        // under the pointer mid-interaction. Confirmed against a real, reproducible failure: with
        // 'smooth' here, Playwright's actionability retries for a click on a target reached via
        // this scroll -- e.g. a persona radio inside the settings-personas step's spotlighted
        // section -- raced the still-running scroll animation and never converged, cycling the
        // page between unrelated scroll offsets for the full retry budget ("element is not
        // stable", then permanent pointer-event interception once the animation and the retries
        // fully decoupled). Jumping straight to the final position removes the race instead of
        // just narrowing it.
        target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
        scrolledTarget = target;
      }
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
          {awaitsRun && runId !== undefined && step.awaitRunStatus !== undefined && (
            <RunStateWatcher runId={runId} expected={step.awaitRunStatus} onGate={setWatchedGate} />
          )}
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
                  Generate Brief is disabled right now, so this step cannot be completed as written:{' '}
                  {generationGate.reason}
                </p>
              </div>
            )}
            {!targetMissing && runGate.notice !== undefined && (
              <div
                role="status"
                className="mt-3 rounded-lg bg-attention/15 px-3 py-2 text-sm text-attention-foreground"
              >
                <p>{runGate.notice}</p>
                {runGate.waiting && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {/* Holding the step is the point; trapping the user in it is not. Waiting can
                        outlast the tour's ability to read the run at all -- an unreadable session,
                        a run page reached outside the protected shell -- and without a deliberate
                        way past, the only exits left are abandoning the tour entirely. */}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => settle(Math.min(stepIndex + 1, tourSteps.length - 1))}
                    >
                      Continue anyway
                    </Button>
                  </div>
                )}
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
                    <Button
                      ref={nextRef}
                      type="button"
                      disabled={runGate.waiting}
                      onClick={() => move(stepIndex + 1)}
                    >
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

/**
 * Watches one run's live state for a step that narrates it, and reports whether that step holds.
 * Rendered only while such a step is on a run page. It subscribes to the very query key the run
 * page already streams its own server-sent updates into, so this normally reads a cache that page
 * keeps warm; the refetch interval is the fallback for a dropped stream and stops once the run is
 * terminal. The session comes from the protected route's loader rather than a query of its own,
 * so the tour adds no observer on the session key.
 */
function RunStateWatcher({
  runId,
  expected,
  onGate
}: Readonly<{
  runId: string;
  expected: readonly RunStatus[];
  onGate: (gate: RunGate) => void;
}>): null {
  const session = useRouteLoaderData('protected-root') as DemoSession | undefined;
  const version = session?.authenticated === true ? session.version : undefined;
  const run = useQuery({
    ...runDetailQueryOptions(version ?? '', runId),
    enabled: version !== undefined,
    refetchInterval: (query) =>
      (query.state.data as RunDetailResponse | undefined)?.terminal === true ? false : 4000
  });
  const { waiting, notice } = describeRunGate(expected, run.data, run.isError);
  useEffect(() => {
    onGate(notice === undefined ? { waiting } : { waiting, notice });
  }, [notice, onGate, waiting]);
  return null;
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
export function advanceGuidedTour(completedAction: string): boolean {
  const state = readTourState();
  const current = tourSteps[state.stepIndex];
  if (
    !state.active ||
    current === undefined ||
    (current.action ?? current.target) !== completedAction
  )
    return false;
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
