import { defineConfig, devices } from '@playwright/test';

// End-to-end tests (spec §9) run against the Vite dev server, which proxies /api to the live
// BaseApi on localhost:18080 (k8s/port-forward-realstack.ps1). The stack is shared and real: every spec goes through
// e2e/fixtures.ts, whose guard lets a write through only to a throwaway workflow the run created, never Start/Stop and
// never a processor or schema edit; global-teardown.ts deletes whatever throwaway is left. Port 5180, so a dev server you
// already run on 5174 is left alone.
//
// Watch it: `npm run e2e:watch` (scripts/e2e-watch.mjs) runs headed with ACTO_SLOWMO=350 ms between actions.
const PORT = 5180;
const slowMo = Number(process.env.ACTO_SLOWMO ?? 0) || 0;

export default defineConfig({
  testDir: './e2e',
  // a slowed, watched run takes several times as long
  timeout: slowMo > 0 ? 300_000 : 90_000,
  expect: { timeout: slowMo > 0 ? 30_000 : 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: { slowMo },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
