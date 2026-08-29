import { BriefcaseBusiness, CircleCheckBig, ListTodo, Settings } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { cn } from '@/lib/utils';

export const primaryDestinations = [
  { label: 'Deals', to: '/deals', icon: BriefcaseBusiness },
  { label: 'Runs', to: '/runs', icon: ListTodo },
  { label: 'Approvals', to: '/approvals', icon: CircleCheckBig },
  { label: 'Settings', to: '/settings', icon: Settings }
] as const;

/** Provides compact navigation to the primary product areas on smaller screens. */
export function MobileNav(): React.JSX.Element {
  const location = useLocation();
  return (
    <nav
      aria-label="Primary"
      data-layout="mobile"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="grid grid-cols-4 px-1 py-1">
        {primaryDestinations.map(({ label, to, icon: Icon }) => {
          const current =
            location.pathname === to || location.pathname.startsWith(`${to}/`)
              ? 'page'
              : label === 'Settings' && location.pathname === '/diagnostics'
                ? 'location'
                : undefined;
          return (
            <li key={to}>
              <Link
                data-tour={label === 'Deals' ? 'nav-deals' : undefined}
                aria-current={current}
                className={cn(
                  'flex min-h-14 min-w-11 flex-col items-center justify-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground',
                  current && 'bg-secondary text-secondary-foreground'
                )}
                to={to}
              >
                <Icon aria-hidden="true" className="size-5" />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
