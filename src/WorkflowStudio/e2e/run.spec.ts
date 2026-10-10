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
  // both enabled whatever the live status: BaseApi's Start and Stop are idempotent (the user's rule, 2026-10-10)
  await expect(start).toBeEnabled();
  await expect(stop).toBeEnabled();

  // an unsaved design: the step block dragged with the real mouse
  const box = (await node(panel, t!.stepId).boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 92, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText('● design draft')).toBeVisible();

  // keys (review 2026-10-09): Ctrl+F5 is the browser's, and F5 does nothing while a dialog is open
  const presses: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/orchestration/')) presses.push(r.url()); });
  await page.keyboard.press('Control+F5');
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('dialog', { name: 'Load workflow' })).toBeVisible();
  await page.keyboard.press('F5');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Load workflow' })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(presses).toEqual([]);
  await expect(page.getByRole('log', { name: 'Output' }).locator('.outl')).toHaveCount(0);
  await expect(page.getByText('● design draft')).toBeVisible();

  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/orchestration/start'));
  await start.click();
  expect((await sent).postDataJSON()).toBe(wf.id);
  await expect(status).toHaveText('▶ running', { timeout: 30_000 });
  await expect(start).toBeEnabled();
  await expect(stop).toBeEnabled();
  expect((await request.get('/api/v1/orchestration/live').then((r) => r.json())) as string[]).toContain(wf.id);
  const started = (await texts(page)).map((l) => l.text);
  expect(started.slice(0, 2)).toEqual([
    'Started the saved workflow; your unsaved design is not part of this run',
    'Start requested: POST /orchestration/start for the workflow BaseApi holds',
  ]);
  // the liveness hub's "running" is the press's confirmation (2026-10-10); it may even beat BaseApi's 202 answer
  expect([
    ['Start accepted by BaseApi (202): starting… waiting for the workflow to appear in the live set', 'running'],
    ['running', 'Start accepted by BaseApi (202)'],
  ]).toContainEqual(started.slice(2));
  // the draft is still the user's, unsaved
  await expect(page.getByText('● design draft')).toBeVisible();
  await shot(page, '5-started');

  // Start again while it runs: sent (BaseApi re-projects what it holds), the 202 ends it at once, still running
  const again = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/orchestration/start'));
  await start.click();
  await again;
  await expect.poll(async () => (await texts(page)).map((l) => l.text).slice(-1)[0]).toBe('Start accepted by BaseApi (202)');
  await expect(status).toHaveText('▶ running');
  await expect(start).toBeEnabled();
  const before = (await texts(page)).length;

  // Stop from the keyboard: Shift+F5 on the active document
  await page.keyboard.press('Shift+F5');
  await expect(status).toHaveText('■ stopped', { timeout: 30_000 });
  await expect(start).toBeEnabled();
  await expect(stop).toBeEnabled();
  expect((await request.get('/api/v1/orchestration/live').then((r) => r.json())) as string[]).not.toContain(wf.id);
  const stopped = (await texts(page)).map((l) => l.text).slice(before);
  expect(stopped[0]).toBe('Stop requested: POST /orchestration/stop for the workflow BaseApi holds');
  expect([
    ['Stop accepted by BaseApi (202): stopping… waiting for the workflow to leave the live set', 'stopped'],
    ['stopped', 'Stop accepted by BaseApi (202)'],
  ]).toContainEqual(stopped.slice(1));
  await shot(page, '6-stopped');

  // Stop again while stopped: sent, the 202 ends it at once, still stopped
  const twice = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/orchestration/stop'));
  await stop.click();
  await twice;
  await expect.poll(async () => (await texts(page)).map((l) => l.text).slice(-1)[0]).toBe('Stop accepted by BaseApi (202)');
  await expect(status).toHaveText('■ stopped');
  expect((await texts(page)).filter((l) => l.red)).toEqual([]);
});
