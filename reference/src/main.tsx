import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './state/store';
import App from './App';
import { SimProvider } from './sim/SimProvider';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider><SimProvider><App /></SimProvider></StoreProvider>
  </StrictMode>,
);

// Offline shell for the installed PWA build (absent in the single-file demo build, which is fine).
if ('serviceWorker' in navigator && location.protocol === 'https:' && !import.meta.env.DEV) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}
