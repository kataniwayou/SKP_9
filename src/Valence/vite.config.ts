import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Valence is same-origin with BaseApi (BaseApi has no CORS policy), as SKP Studio is. In dev the proxy points at the
// RealStack port-forward; in the cluster nginx does the same job (nginx.conf). SKP_API points it at another BaseApi
// (e.g. a branch's BaseApi run locally). Port 5174: SKP Studio's dev server keeps 5173.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: process.env.SKP_API ?? 'http://localhost:18080' },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
