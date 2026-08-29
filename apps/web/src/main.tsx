import '@fontsource-variable/geist';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { queryClient } from './api/session';
import { DiagnosticsRoute, diagnosticsLoader } from './routes/diagnostics';
import { ForbiddenRoute } from './routes/forbidden';
import { LoginRoute } from './routes/login';
import { NotFoundRoute } from './routes/not-found';
import { RootRoute, ApprovalsHomeRoute, DealsHomeRoute, RunsHomeRoute, protectedRootLoader } from './routes/root';
import { RouteErrorBoundary } from './routes/route-error';
import { RoutePending } from './routes/route-pending';
import { SettingsRoute, settingsLoader } from './routes/settings';
import { UnauthorizedRoute } from './routes/unauthorized';
import './styles/globals.css';

const router = createBrowserRouter([
  { path: '/login', element: <LoginRoute />, errorElement: <RouteErrorBoundary /> },
  { path: '/unauthorized', element: <UnauthorizedRoute /> },
  { path: '/forbidden', element: <ForbiddenRoute /> },
  {
    id: 'protected-root',
    path: '/',
    loader: protectedRootLoader,
    element: <RootRoute />,
    hydrateFallbackElement: <RoutePending />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <Navigate to="/deals" replace /> },
      { path: 'deals', element: <DealsHomeRoute /> },
      { path: 'runs', element: <RunsHomeRoute /> },
      { path: 'approvals', element: <ApprovalsHomeRoute /> },
      { path: 'settings', loader: settingsLoader, element: <SettingsRoute />, errorElement: <RouteErrorBoundary /> },
      { path: 'diagnostics', loader: diagnosticsLoader, element: <DiagnosticsRoute />, errorElement: <RouteErrorBoundary /> },
      { path: '*', element: <NotFoundRoute /> }
    ]
  }
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
