import { AlertTriangle } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/button';

type AppErrorBoundaryProps = Readonly<{ children: ReactNode }>;
type AppErrorBoundaryState = Readonly<{ failed: boolean }>;

/** Keeps an unexpected React rendering failure from leaving the application as a blank screen. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public state: AppErrorBoundaryState = { failed: false };

  /** Marks the application as failed when React reports an unrecoverable rendering error. */
  public static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  /** Records unexpected rendering failures for operators without exposing technical details to users. */
  public componentDidCatch(error: Error, details: ErrorInfo): void {
    console.error('Uncaught application render failure', error, details);
  }

  /** Shows recovery guidance after a rendering failure or the protected application otherwise. */
  public render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="grid min-h-dvh place-items-center bg-background px-5 py-12">
        <section role="alert" className="w-full max-w-2xl rounded-xl border bg-card p-6 sm:p-8">
          <span className="grid size-11 place-items-center rounded-full bg-secondary text-secondary-foreground">
            <AlertTriangle aria-hidden="true" />
          </span>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">
            The application could not be loaded
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            An unexpected interface error occurred. Reload the application to try again.
          </p>
          <Button
            className="mt-5 min-h-11"
            variant="outline"
            onClick={() => window.location.reload()}
          >
            Reload application
          </Button>
        </section>
      </main>
    );
  }
}
