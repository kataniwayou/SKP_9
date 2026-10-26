import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The chat's model (2026-10-26, as SKP Studio's): the model's base URL, id and key come from the dev environment, as nginx
// takes them from the pod's (KIMI_BASE_URL, KIMI_MODEL_ID, KIMI_API_KEY; never written anywhere). Without all three /ai is
// not proxied and Valence says the chat is not configured.
const { KIMI_API_KEY: aiKey, KIMI_BASE_URL: aiBaseUrl, KIMI_MODEL_ID: aiModel } = process.env;
const aiBase = aiKey && aiBaseUrl && aiModel ? new URL(aiBaseUrl) : null;
/** /ai/config, as nginx answers it: the model Valence sends. */
const aiConfig: Plugin = {
  name: 'skp-ai-config',
  configureServer(server) {
    server.middlewares.use('/ai/config', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = aiBase ? 200 : 503;
      res.end(JSON.stringify(aiBase ? { model: aiModel } : { error: 'The chat is not configured' }));
    });
  },
};

// Valence is same-origin with BaseApi (BaseApi has no CORS policy), as SKP Studio is. In dev the proxy points at the
// RealStack port-forward; in the cluster nginx does the same job (nginx.conf). SKP_API points it at another BaseApi
// (e.g. a branch's BaseApi run locally). Port 5174: SKP Studio's dev server keeps 5173.
export default defineConfig({
  plugins: [react(), aiConfig],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: process.env.SKP_API ?? 'http://localhost:18080' },
      ...(aiBase ? {
        '/ai': {
          target: aiBase.origin, changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/ai\//, `${aiBase.pathname.replace(/\/+$/, '')}/`),
          headers: { Authorization: `Bearer ${aiKey}` },
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
