import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StoreProvider } from './state/store';
import App from './App';
import { LiveProvider } from './live/LiveProvider';
import './styles.css';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <StoreProvider>
        <LiveProvider>
          <App />
        </LiveProvider>
      </StoreProvider>
    </QueryClientProvider>
  </StrictMode>,
);
