import { LogIn, Shield } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';

/** Explains that sign-in is required and offers a safe route back into the product. */
export function UnauthorizedRoute(): React.JSX.Element {
  const location = useLocation();
  const returnTo = new URLSearchParams(location.search).get('returnTo');
  const safeReturnTo =
    returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : undefined;
  const loginTarget =
    safeReturnTo === undefined
      ? '/login'
      : `/login?${new URLSearchParams({ returnTo: safeReturnTo }).toString()}`;
  return (
    <AccessState
      eyebrow="Session required"
      title="Sign in to continue"
      detail="Choose one of the canonical demo personas to enter SlaCato. Your original destination stays out of the URL unless it is a safe application path."
      icon={LogIn}
      action={
        <Button asChild>
          <Link to={loginTarget}>Choose a persona</Link>
        </Button>
      }
    />
  );
}

/** Presents a consistent access-state message with its recommended next action. */
export function AccessState({
  eyebrow,
  title,
  detail,
  icon: Icon,
  action,
  tourTarget,
  children
}: Readonly<{
  eyebrow: string;
  title: string;
  detail: string;
  icon: typeof LogIn;
  action: React.ReactNode;
  tourTarget?: string;
  children?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <main
      id="main-content"
      className="grid min-h-screen place-items-center bg-background px-5 py-12"
    >
      <section
        data-tour={tourTarget}
        className="w-full max-w-lg rounded-2xl border bg-card p-7 shadow-sm sm:p-10"
      >
        <span className="mb-6 grid size-12 place-items-center rounded-xl bg-secondary text-secondary-foreground">
          <Icon className="size-6" />
        </span>
        <p className="text-sm font-medium text-primary">{eyebrow}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-4 leading-7 text-muted-foreground">{detail}</p>
        <div className="mt-7">{action}</div>
        <div className="mt-8 flex items-center gap-2 border-t pt-5 text-xs text-muted-foreground">
          <Shield className="size-4" /> SlaCato keeps denied account details private.
        </div>
      </section>
      {children}
    </main>
  );
}
