/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Product UI on :5173. API calls go through the dev proxy to FastAPI on :8000 (same origin → no CORS, SSE works).
// /api, the OpenAPI docs and the schema go to FastAPI, so a phone on the Wi-Fi needs only this one address.
const API = { target: 'http://127.0.0.1:8000', changeOrigin: true };
const API_PROXY = { '/api': API, '/docs': API, '/redoc': API, '/openapi.json': API };

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, strictPort: true, proxy: API_PROXY },
  preview: { host: true, port: 5173, proxy: API_PROXY },
  test: { environment: 'node' },
});
