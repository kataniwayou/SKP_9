import type { Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { forget, heartbeats } from './redis';
import { documentPanel, expect, inspector, liveWorkflows, node, openWorkflow, outputLines, selectProcessor, test } from './studio';
import { createThrowaway, created, removeThrowaway, type Throwaway } from './throwaway';

// Live push (2026-10-10): a processor going not live turns its steps' art red in every document, shown or hidden,
// without a refresh. The processor is this run's throwaway (`e2e-8-…-proc`), whose heartbeats the test writes in Redis
// in the processors' own key format and then stops; no real processor is touched.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
const instance = `e2e-live-${randomBytes(3).toString('hex')}`;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => {
  try { if (created.processorId) await forget(created.processorId, instance); } finally { await removeThrowaway(request); }
});

const SHOTS = process.env.LIVE_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

test('a processor whose heartbeats stop turns its step art red without a refresh, hidden tab too; Output logs nothing for it', async ({ page, request }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const health = node(panel, t.stepId).locator('.nx-health');
  // no replica has ever written: not live
  await expect(health).toHaveAttribute('data-health', 'unhealthy', { timeout: 15_000 });

  const stop = heartbeats(t.processorId, instance);
  try {
    await expect(health).toHaveAttribute('data-health', 'healthy', { timeout: 10_000 });
    expect(await selectProcessor(page, panel)).toBe(true);
    await expect(inspector(page).getByLabel('Liveness')).toHaveText('live · 1 of 1 replica healthy');
    await shot(page, '5-processor-live');
  } finally {
    await stop();
  }
  const stopped = Date.now();
  await expect(health).toHaveAttribute('data-health', 'unhealthy', { timeout: 10_000 });
  // stale once its last beat is 2 s old, read every 2 s
  expect(Date.now() - stopped).toBeLessThan(8000);
  await expect(inspector(page).getByLabel('Liveness')).toHaveText(/^not live · no healthy replica \(1 checked: /);
  await shot(page, '6-processor-not-live');

  // the same while its tab is hidden behind another workflow
  const [other] = await liveWorkflows(request, 1);
  await openWorkflow(page, other!);
  await expect(panel).toHaveClass(/\bbg\b/);
  const again = heartbeats(t.processorId, instance);
  try {
    await expect(health).toHaveAttribute('data-health', 'healthy', { timeout: 10_000 });
  } finally {
    await again();
  }
  await expect(health).toHaveAttribute('data-health', 'unhealthy', { timeout: 10_000 });

  // processors are never logged
  await expect(await outputLines(page)).toHaveCount(0);
});
