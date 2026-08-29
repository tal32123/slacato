import { useState } from 'react';
import type { DemoSession } from '@slacato/contracts';
import { PanelLeftClose, PanelLeftOpen, ShieldCheck } from 'lucide-react';
import { Link, Outlet, useLocation, useNavigation } from 'react-router';
import { MobileNav, primaryDestinations } from '@/components/mobile-nav';
import { PersonaMenu } from '@/components/persona-menu';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function AppShell({ session, onLogout }: Readonly<{
  session: DemoSession;
  onLogout: () => Promise<void>;
}>): React.JSX.Element {
  const [expanded, setExpanded] = useState(() => window.matchMedia('(min-width: 1280px)').matches);
  const location = useLocation();
  const navigation = useNavigation();

  return (
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[auto_minmax(0,1fr)]">
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-50 -translate-y-24 rounded-md bg-primary px-4 py-3 font-medium text-primary-foreground transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>

      <aside
        className={cn(
          'sticky top-0 hidden h-dvh flex-col overflow-y-auto bg-brand-forest text-brand-pale lg:flex',
          expanded ? 'w-60' : 'w-18'
        )}
      >
        <div className="flex min-h-18 items-center gap-3 border-b border-brand-mint/20 px-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-md bg-brand-mint text-brand-forest">
            <ShieldCheck aria-hidden="true" className="size-6" />
          </span>
          <span className={cn('text-lg font-semibold tracking-tight', !expanded && 'sr-only')}>SlaCato</span>
        </div>

        <nav aria-label="Primary" data-layout="desktop" className="flex-1 px-2 py-5">
          <ul className="grid gap-1">
            {primaryDestinations.map(({ label, to, icon: Icon }) => {
              const current = location.pathname === to || (label === 'Settings' && location.pathname === '/diagnostics');
              return (
                <li key={to}>
                  <Link
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
          <Link
            to="/diagnostics"
            className="flex min-h-11 min-w-11 items-center gap-3 rounded-md px-3 text-sm text-brand-pale/75 hover:bg-brand-medium hover:text-brand-pale"
          >
            <ShieldCheck aria-hidden="true" className="size-5 shrink-0" />
            <span className={cn(!expanded && 'sr-only')}>Demo Diagnostics</span>
          </Link>
          <Button
            aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
            variant="ghost"
            className="mt-1 min-h-11 w-full justify-start px-3 text-brand-pale/75 hover:bg-brand-medium hover:text-brand-pale"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
            <span className={cn(!expanded && 'sr-only')}>{expanded ? 'Collapse' : 'Expand'}</span>
          </Button>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 border-b bg-background/95">
          <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
            <div className="min-w-0">
              <Link to="/deals" className="inline-flex min-h-11 min-w-11 items-center text-base font-semibold tracking-tight lg:hidden">SlaCato</Link>
              <p className="hidden text-sm text-muted-foreground sm:block lg:block">Negotiation preparation, grounded in authorized evidence</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden sm:inline-flex"><StatusBadge status="ready" label="Signed session" /></span>
              <PersonaMenu session={session} onLogout={onLogout} />
            </div>
          </div>
        </header>

        {navigation.state !== 'idle' && (
          <div role="status" aria-label="Loading destination" className="border-b bg-secondary px-4 py-2 text-center text-sm text-secondary-foreground">
            Loading destination…
          </div>
        )}

        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-7xl px-4 py-7 pb-24 sm:px-6 sm:py-9 lg:px-8 lg:pb-10">
          <Outlet />
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
