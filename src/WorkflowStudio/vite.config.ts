import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The studio is same-origin with BaseApi (BaseApi has no CORS policy). In dev the proxy points at
// the RealStack port-forward; in the cluster nginx does the same job (nginx.conf). SKP_API points it at
// another BaseApi (e.g. a branch's BaseApi run locally) for the dev server and the e2e tests.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // ws: the liveness hub (/api/hubs/liveness) is a WebSocket (2026-10-10)
    proxy: { '/api': { target: process.env.SKP_API ?? 'http://localhost:18080', ws: true } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
