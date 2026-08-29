import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

/** Helps users recover when a requested product page does not exist. */
export function NotFoundRoute(): React.JSX.Element {
  return (
    <section className="mx-auto max-w-2xl py-10" aria-labelledby="not-found-title">
      <p className="text-sm font-medium text-primary">404</p>
      <h1 id="not-found-title" className="mt-2 text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-3 max-w-xl leading-6 text-muted-foreground">
        This destination is not part of the authorized SlaCato workspace. No hidden resource details were requested or displayed.
      </p>
      <Button asChild variant="outline" className="mt-6 min-h-11">
        <Link to="/deals"><ArrowLeft aria-hidden="true" />Back to Deals</Link>
      </Button>
    </section>
  );
}
