import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the Vite dev server with real mouse drags. By default BaseApi is a stand-in served from a
// fresh copy of the cluster's project (src/test/fixtures/project.json, e2e/standin.ts): no cluster, no port-forward, and
// nothing can be written. VALENCE_E2E_LIVE=1 reads the cluster's BaseApi instead (localhost:18080, GETs and the dry run
// only; the dry run is rolled back). Every other non-GET is aborted in both modes; Apply never reaches BaseApi.
// Port 5184, so a dev server on 5174 and SKP Studio's suite on 5179 are left alone.
const PORT = 5184;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // the canvas is WebGL: software rendering, as the earlier browser checks ran it
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    // the halos breathe and an AI drawing glides; reduced motion makes the checks steady
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
