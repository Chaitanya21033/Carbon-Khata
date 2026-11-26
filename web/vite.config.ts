/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Product UI on :5173. API calls go through the dev proxy to FastAPI on :8000 (same origin → no CORS, SSE works).
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } } },
  preview: { host: true, port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } } },
  test: { environment: 'node' },
});
