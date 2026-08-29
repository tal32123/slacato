import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { isRouteErrorResponse, useRevalidator, useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';

export function RouteErrorBoundary({ root = false }: Readonly<{ root?: boolean }>): React.JSX.Element {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const denied = isRouteErrorResponse(error) && error.status === 403;
  const errorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let inner: number | undefined;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => {
        document.title = 'Unavailable view | SlaCato';
        errorRef.current?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(outer);
      if (inner !== undefined) window.cancelAnimationFrame(inner);
    };
  }, [error]);


  const content = (
    <section ref={errorRef} tabIndex={-1} role="alert" aria-atomic="true" className="mx-auto max-w-2xl rounded-xl border bg-card p-6 sm:p-8" aria-labelledby="route-error-title">
      <span className="grid size-11 place-items-center rounded-full bg-secondary text-secondary-foreground">
        <AlertTriangle aria-hidden="true" />
      </span>
      <h1 id="route-error-title" className="mt-5 text-2xl font-semibold tracking-tight">
        {denied ? 'This view is not available' : 'This view could not be loaded'}
      </h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {denied
          ? 'Your current persona is not authorized for this destination. No restricted details were loaded.'
          : 'The service did not return a valid view. Try the request again.'}
      </p>
      {!denied && (
        <Button className="mt-5 min-h-11" variant="outline" onClick={() => revalidator.revalidate()}>
          Try again
        </Button>
      )}
    </section>
  );

  if (root) return <main className="grid min-h-dvh place-items-center bg-background px-5 py-12">{content}</main>;
  return content;
}
