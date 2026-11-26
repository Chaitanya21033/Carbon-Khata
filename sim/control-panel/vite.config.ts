import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Demo controls on :5174, talking to the simulator's control API on :5175. Never part of the product.
export default defineConfig({ plugins: [react()], server: { host: true, port: 5174, strictPort: true, allowedHosts: true, proxy: { '/sim': 'http://127.0.0.1:5175' } } });
