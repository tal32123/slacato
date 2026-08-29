import { LoaderCircle, ShieldCheck } from 'lucide-react';

/** Shows a full-page loading state while the next route is prepared. */
export function RoutePending(): React.JSX.Element {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-5">
      <div
        role="status"
        aria-label="Loading SlaCato"
        className="flex items-center gap-3 text-sm text-muted-foreground"
      >
        <span className="grid size-11 place-items-center rounded-md bg-secondary text-secondary-foreground">
          <ShieldCheck aria-hidden="true" />
        </span>
        <span>
          <span className="block font-medium text-foreground">SlaCato</span>
          <span className="inline-flex items-center gap-2">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            Authorizing workspace…
          </span>
        </span>
      </div>
    </main>
  );
}
