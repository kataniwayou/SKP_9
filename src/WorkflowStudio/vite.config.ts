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
    // ai: AI drawing (2026-10-11) goes to the model only when KIMI_API_KEY is set in the dev environment (never written
    // anywhere); without it /ai is not proxied and the studio says AI drawing is not configured
    proxy: {
      '/api': { target: process.env.SKP_API ?? 'http://localhost:18080', ws: true },
      ...(process.env.KIMI_API_KEY ? {
        '/ai': {
          target: 'https://api.moonshot.ai', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/ai\//, '/v1/'),
          headers: { Authorization: `Bearer ${process.env.KIMI_API_KEY}` },
        },
      } : {}),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
