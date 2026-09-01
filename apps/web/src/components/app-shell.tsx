import type { DemoSession } from '@slacato/contracts';
import { PanelLeftClose, PanelLeftOpen, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Link,
  Outlet,
  ScrollRestoration,
  useLocation,
  useNavigation,
  useNavigationType
} from 'react-router';
import { GuidedTour } from '@/components/guided-tour';
import { MobileNav, primaryDestinations } from '@/components/mobile-nav';
import { PersonaMenu } from '@/components/persona-menu';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Frames protected pages with navigation, session controls, guided help, and accessible focus handling. */
export function AppShell({
  session,
  onLogout
}: Readonly<{
  session: DemoSession;
  onLogout: () => Promise<void>;
}>): React.JSX.Element {
  const [expanded, setExpanded] = useState(() => window.matchMedia('(min-width: 1280px)').matches);
  const location = useLocation();
  const navigation = useNavigation();
  const navigationType = useNavigationType();
  const mainRef = useRef<HTMLElement>(null);
  const previouslyFocusedPathname = useRef<string | undefined>(undefined);

  useEffect(() => {
    const preferredRail = window.matchMedia('(min-width: 1280px)');
    const applyPreferredRail = (event: MediaQueryListEvent): void => setExpanded(event.matches);
    setExpanded(preferredRail.matches);
    preferredRail.addEventListener('change', applyPreferredRail);
    return () => preferredRail.removeEventListener('change', applyPreferredRail);
  }, []);
  useEffect(() => {
    const section = location.pathname.split('/').filter(Boolean)[0] ?? 'deals';
    const title =
      section === 'approvals'
        ? 'Approvals'
        : section === 'runs'
          ? 'Runs'
          : section === 'walkthrough'
            ? 'Walkthrough'
            : section === 'settings'
              ? 'Settings'
              : section === 'diagnostics'
                ? 'Diagnostics'
                : 'Deals';
    document.title = `${title} | SlaCato`;
    const focusOwner = (location.state as { focusOwner?: unknown } | null)?.focusOwner;
    const pathnameChanged = previouslyFocusedPathname.current !== location.pathname;
    if (pathnameChanged && navigationType !== 'POP' && focusOwner !== 'approval-status') {
      // Record only what we actually focused. Updating this on a skipped navigation (a POP, or an
      // approval-status update) makes the next real navigation to that same path look unchanged,
      // so main is never focused and a keyboard user is stranded on the link they just activated.
      previouslyFocusedPathname.current = location.pathname;
      // preventScroll keeps this purely a focus move. Without it the browser scrolled <main> to the
      // top of the viewport, which parked every freshly opened page at scrollY 65 with its first
      // line hidden under the sticky header. ScrollRestoration below owns scroll position instead.
      //
      // The frame is what makes this a *default* rather than an override: it can land arbitrarily
      // late on a loaded machine -- long after something else deliberately claimed focus. Closing
      // the guided tour does exactly that, returning focus to its launcher on the commit that
      // closes; a late frame from the navigation that opened the step then stole it straight back
      // to <main>, leaving a keyboard user with no way to resume. So take focus only if nothing
      // else has: still on <body>, or still on whatever was focused when this was scheduled (the
      // nav link the user just activated, which is the case this focus move exists to rescue).
      const scheduledFrom = document.activeElement;
      window.requestAnimationFrame(() => {
        const claimed = document.activeElement;
        if (claimed !== null && claimed !== document.body && claimed !== scheduledFrom) return;
        mainRef.current?.focus({ preventScroll: true });
      });
    }
  }, [location.pathname, location.state, navigationType]);

  return (
    <div
      data-protected-app-shell
      className="min-h-dvh bg-background lg:grid lg:grid-cols-[auto_minmax(0,1fr)]"
    >
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-50 -translate-y-24 rounded-md bg-primary px-4 py-3 font-medium text-primary-foreground transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>

      <aside
        data-state={expanded ? 'expanded' : 'collapsed'}
        className={cn(
          'sticky top-0 hidden h-dvh flex-col overflow-y-auto bg-brand-forest text-brand-pale lg:flex',
          expanded ? 'w-60' : 'w-18'
        )}
      >
        <div className="flex min-h-18 items-center gap-3 border-b border-brand-mint/20 px-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-md bg-brand-mint text-brand-forest">
            <ShieldCheck aria-hidden="true" className="size-6" />
          </span>
          <span className={cn('text-lg font-semibold tracking-tight', !expanded && 'sr-only')}>
            SlaCato
          </span>
        </div>

        <nav aria-label="Primary" data-layout="desktop" className="flex-1 px-2 py-5">
          <ul className="grid gap-1">
            {primaryDestinations.map(({ label, to, icon: Icon }) => {
              const current = location.pathname === to || location.pathname.startsWith(`${to}/`);
              return (
                <li key={to}>
                  <Link
                    data-tour={label === 'Deals' ? 'nav-deals' : undefined}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'flex min-h-11 min-w-11 items-center gap-3 rounded-md px-3 text-sm font-medium text-brand-pale/75 transition-colors hover:bg-brand-medium hover:text-brand-pale',
                      current && 'bg-brand-medium text-brand-mint'
                    )}
                    to={to}
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    <span className={cn(!expanded && 'sr-only')}>{label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-brand-mint/20 p-2">
          <nav aria-label="Secondary">
            <Link
              aria-current={location.pathname === '/diagnostics' ? 'page' : undefined}
              to="/diagnostics"
              className={cn(
                'flex min-h-11 min-w-11 items-center gap-3 rounded-md px-3 text-sm text-brand-pale/75 hover:bg-brand-medium hover:text-brand-pale',
                location.pathname === '/diagnostics' && 'bg-brand-medium text-brand-mint'
              )}
            >
              <ShieldCheck aria-hidden="true" className="size-5 shrink-0" />
              <span className={cn(!expanded && 'sr-only')}>Demo Diagnostics</span>
            </Link>
          </nav>
          <Button
            aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
            variant="ghost"
            className="mt-1 min-h-11 w-full justify-start px-3 text-brand-pale/75 hover:bg-brand-medium hover:text-brand-pale"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <PanelLeftClose aria-hidden="true" />
            ) : (
              <PanelLeftOpen aria-hidden="true" />
            )}
            <span className={cn(!expanded && 'sr-only')}>{expanded ? 'Collapse' : 'Expand'}</span>
          </Button>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 border-b bg-background/95">
          {/* The route-loading notice is a permanently mounted live region so assistive technology
              announces it (a region that mounts together with its text is often missed), and it is
              painted as an overlay hanging off the header's bottom edge rather than as a block in
              the document flow. Inserting a block here used to push <main> down ~37px the instant a
              link was activated and pull it back when the loader resolved, so the control under the
              pointer jumped on every navigation. */}
          <div
            role="status"
            aria-label="Loading destination"
            className="pointer-events-none absolute inset-x-0 top-full z-10 flex justify-center px-4"
          >
            {navigation.state !== 'idle' && (
              <span className="rounded-b-md border border-t-0 bg-secondary px-4 py-2 text-sm text-secondary-foreground shadow-sm">
                Loading destination…
              </span>
            )}
          </div>
          <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
            <div className="min-w-0">
              <Link
                to="/deals"
                className="inline-flex min-h-11 min-w-11 items-center text-base font-semibold tracking-tight lg:hidden"
              >
                SlaCato
              </Link>
              <p className="hidden text-sm text-muted-foreground sm:block lg:block">
                Negotiation preparation, grounded in authorized evidence
              </p>
            </div>
            <div
              id="active-persona-control"
              data-tour="persona"
              className="flex shrink-0 items-center gap-2"
            >
              <span className="hidden sm:inline-flex">
                <StatusBadge status="ready" label="Signed session" />
              </span>
              <PersonaMenu session={session} onLogout={onLogout} />
            </div>
          </div>
        </header>

        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          // The guided-tour launcher is a fixed bottom-right control at every breakpoint (it only
          // moves closer to the edge at lg, once the mobile tab bar it shares space with is gone).
          // This reserve must clear its full footprint so a page whose content ends flush with the
          // viewport bottom, like a short approvals inbox, never renders a real action underneath it.
          className="mx-auto w-full max-w-7xl px-4 py-7 pb-24 sm:px-6 sm:py-9 lg:px-8 lg:pb-20"
        >
          <Outlet />
        </main>
      </div>
      {/* Keyed by pathname so opening or closing the evidence panel -- which only pushes a search
          param onto the same path -- restores the reader's position instead of yanking the page to
          the top, while a genuine move to another page still starts at the top. */}
      <ScrollRestoration getKey={(location) => location.pathname} />
      <MobileNav />
      <GuidedTour />
    </div>
  );
}
