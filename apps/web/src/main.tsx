import '@fontsource-variable/geist';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/globals.css';

const queryClient = new QueryClient();

function App(): React.JSX.Element {
  return <main className="min-h-screen bg-background p-6 text-foreground">SlaCato</main>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>
);
