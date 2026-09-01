import '@fontsource-variable/geist';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { queryClient } from './api/session';
import { AppErrorBoundary } from './components/app-error-boundary';
import { ApprovalRoute, approvalLoader } from './routes/approval';
import { ApprovalsRoute, approvalsLoader } from './routes/approvals';
import { DealRoute, dealLoader } from './routes/deal';
import { DealsRoute, dealsLoader } from './routes/deals';
import { DiagnosticsRoute, diagnosticsLoader } from './routes/diagnostics';
import { ForbiddenRoute } from './routes/forbidden';
import { LoginRoute } from './routes/login';
import { NotFoundRoute } from './routes/not-found';
import { protectedRootLoader, RootRoute } from './routes/root';
import { RouteErrorBoundary } from './routes/route-error';
import { RoutePending } from './routes/route-pending';
import { RunRoute, runLoader } from './routes/run';
import { RunsRoute, runsLoader } from './routes/runs';
import { SettingsRoute, settingsLoader } from './routes/settings';
import { unauthorizedLoader } from './routes/unauthorized';
import { WalkthroughRoute } from './routes/walkthrough';
import './styles/globals.css';

const router = createBrowserRouter([
  { path: '/login', element: <LoginRoute />, errorElement: <RouteErrorBoundary root /> },
  { path: '/unauthorized', loader: unauthorizedLoader, element: <RoutePending /> },
  { path: '/forbidden', element: <ForbiddenRoute /> },
  {
    id: 'protected-root',
    path: '/',
    loader: protectedRootLoader,
    shouldRevalidate: () => true,
    element: <RootRoute />,
    hydrateFallbackElement: <RoutePending />,
    errorElement: <RouteErrorBoundary root />,
    children: [
      { index: true, element: <Navigate to="/deals" replace /> },
      {
        path: 'deals',
        loader: dealsLoader,
        element: <DealsRoute />,
        errorElement: <RouteErrorBoundary />
      },
      {
        path: 'deals/:opportunityId',
        loader: dealLoader,
        element: <DealRoute />,
        errorElement: <RouteErrorBoundary />
      },
      {
        path: 'runs',
        loader: runsLoader,
        element: <RunsRoute />,
        errorElement: <RouteErrorBoundary />
      },
      {
        path: 'runs/:runId',
        loader: runLoader,
        element: <RunRoute />,
        errorElement: <RouteErrorBoundary />
      },
      {
        path: 'approvals',
        loader: approvalsLoader,
        element: <ApprovalsRoute />,
        errorElement: <RouteErrorBoundary />
      },
      {
        path: 'approvals/:subjectId',
        loader: approvalLoader,
        element: <ApprovalRoute />,
        errorElement: <RouteErrorBoundary />
      },
      {
        path: 'settings',
        loader: settingsLoader,
        element: <SettingsRoute />,
        errorElement: <RouteErrorBoundary />
      },
      {
        path: 'diagnostics',
        loader: diagnosticsLoader,
        element: <DiagnosticsRoute />,
        errorElement: <RouteErrorBoundary />
      },
      { path: 'walkthrough', element: <WalkthroughRoute />, errorElement: <RouteErrorBoundary /> },
      { path: '*', element: <NotFoundRoute /> }
    ]
  }
]);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Application root element "#root" was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>
);
