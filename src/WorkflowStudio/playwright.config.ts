import { defineConfig, devices } from '@playwright/test';

// End-to-end tests (spec §9) run against the Vite dev server, which proxies /api to the live
// BaseApi on localhost:18080 (k8s/port-forward-realstack.ps1). They only read (GETs), except
// save.spec.ts, which saves a throwaway workflow it creates and deletes (plan 8 §8). Port 5179, so a
// dev server you already run on 5173 is left alone.
const PORT = 5179;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
