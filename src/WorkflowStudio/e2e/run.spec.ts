import type { Page } from '@playwright/test';
import { documentPanel, node, openWorkflow, outputLines } from './studio';
import { createRunThrowaway, expect, removeThrowaway, stopRunThrowaway, test, type RunThrowaway } from './throwaway';

// Start and Stop act on the saved workflow BaseApi holds, not the drawing (the user's decisions, 2026-10-09). Real
// mouse. Starts and stops only this run's throwaway (`e2e-run-…`: one step on a live processor with no schemas, no
// cron, so it never fires); the write guard refuses a Start or Stop of anything else.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: RunThrowaway | null;
test.beforeAll(async ({ request }) => { t = await createRunThrowaway(request); });
test.afterAll(async ({ request }) => {
  try { await stopRunThrowaway(request); } finally { await removeThrowaway(request); }
});
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.OUTPUT_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const texts = async (page: Page) => (await outputLines(page)).evaluateAll((els) => els.map((el) => ({
  text: [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(), red: el.classList.contains('err'),
})));

test('Start with an unsaved design notes it and starts the saved workflow; the status follows the live set; then Stop', async ({ page, request }) => {
  test.skip(t === null, 'no live processor without schemas in the cluster to start a throwaway on');
  const wf = t!.workflow;
  await openWorkflow(page, wf);
  const panel = documentPanel(page, wf);
  const status = panel.getByLabel('Status');
  const start = panel.getByRole('button', { name: /Start/ });
  const stop = panel.getByRole('button', { name: /Stop/ });
  await expect(status).toHaveText('■ stopped', { timeout: 15_000 });
  await expect(start).toBeEnabled();
  await expect(stop).toBeDisabled();

  // an unsaved design: the step block dragged with the real mouse
  const box = (await node(panel, t!.stepId).boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 92, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText('● design draft')).toBeVisible();

  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/orchestration/start'));
  await start.click();
  expect((await sent).postDataJSON()).toBe(wf.id);
  await expect(status).toHaveText('▶ running', { timeout: 30_000 });
  await expect(start).toBeDisabled();
  await expect(stop).toBeEnabled();
  expect((await request.get('/api/v1/orchestration/live').then((r) => r.json())) as string[]).toContain(wf.id);
  const started = (await texts(page)).map((l) => l.text);
  expect(started).toEqual([
    'Started the saved workflow; your unsaved design is not part of this run',
    'Start requested: POST /orchestration/start for the workflow BaseApi holds',
    'Start accepted by BaseApi (202): starting… waiting for the workflow to appear in the live set',
    'running: the workflow is in BaseApi\'s live set',
  ]);
  // the draft is still the user's, unsaved
  await expect(page.getByText('● design draft')).toBeVisible();
  await shot(page, '5-started');

  await stop.click();
  await expect(status).toHaveText('■ stopped', { timeout: 30_000 });
  await expect(start).toBeEnabled();
  await expect(stop).toBeDisabled();
  expect((await request.get('/api/v1/orchestration/live').then((r) => r.json())) as string[]).not.toContain(wf.id);
  expect((await texts(page)).map((l) => l.text).slice(4)).toEqual([
    'Stop requested: POST /orchestration/stop for the workflow BaseApi holds',
    'Stop accepted by BaseApi (202): stopping… waiting for the workflow to leave the live set',
    'stopped: the workflow left BaseApi\'s live set',
  ]);
  expect((await texts(page)).filter((l) => l.red)).toEqual([]);
  await shot(page, '6-stopped');
});
