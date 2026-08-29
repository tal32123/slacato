import { useEffect, useState } from 'react';
import type { DemoSession } from '@slacato/contracts';
import { ChevronDown, LogOut, Settings, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { sessionRuntime } from '@/api/session';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

/** Shows the active persona and provides access to settings or secure sign-out. */
export function PersonaMenu({ session, onLogout }: Readonly<{
  session: DemoSession;
  onLogout: () => Promise<void>;
}>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => sessionRuntime.registerOverlayCloser(() => setOpen(false)), []);

  const logOut = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button aria-label={`${session.persona.displayName}, ${session.persona.role}`} variant="outline" className="min-h-11 max-w-64 justify-start gap-2 px-2 sm:px-3">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
            {initials(session.persona.displayName)}
          </span>
          <span className="min-w-0 text-left">
            <span className="block truncate text-sm font-medium">{session.persona.displayName}</span>
            <span className="hidden truncate text-xs text-muted-foreground sm:block">{session.persona.role}</span>
          </span>
          <ChevronDown aria-hidden="true" className="ml-auto size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          <span className="block text-xs font-normal text-muted-foreground">Active persona</span>
          <span>{session.persona.displayName}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="min-h-11">
          <Link to="/settings"><Settings aria-hidden="true" />Persona &amp; session</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="min-h-11">
          <Link to="/diagnostics"><ShieldCheck aria-hidden="true" />Demo Diagnostics</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          className="min-h-11"
          disabled={loggingOut}
          onSelect={() => void logOut()}
        >
          <LogOut aria-hidden="true" />{loggingOut ? 'Logging out…' : 'Log out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Produces a compact avatar label from a persona's name. */
function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}
