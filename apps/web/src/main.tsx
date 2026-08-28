import '@fontsource-variable/geist';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { LoginRoute } from './routes/login';
import { UnauthorizedRoute } from './routes/unauthorized';
import { ForbiddenRoute } from './routes/forbidden';
import { WorkspaceRoute } from './routes/workspace';
import './styles/globals.css';

const queryClient = new QueryClient();
const router = createBrowserRouter([
  { path: '/', element: <WorkspaceRoute /> },
  { path: '/login', element: <LoginRoute /> },
  { path: '/unauthorized', element: <UnauthorizedRoute /> },
  { path: '/forbidden', element: <ForbiddenRoute /> },
  { path: '*', element: <Navigate to="/" replace /> }
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>
);
