import type { APIRequestContext, Page, Request, WebSocketRoute } from '@playwright/test';
import { documentPanel, expect, liveWorkflows, openWorkflow, outputLines, test } from './studio';
import { createRunThrowaway, removeThrowaway, stopRunThrowaway, type RunThrowaway } from './throwaway';

// Live push (2026-10-10): BaseApi's liveness hub feeds one store for the whole studio. Real mouse for what the user does;
// the throwaway (`e2e-run-…`: one step on a live, schema-less processor, no cron) is started and stopped by the test's
// own requests, as another client would, so only the push can tell the studio. The browser itself only reads.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: RunThrowaway | null;
test.beforeAll(async ({ request }) => { t = await createRunThrowaway(request); });
test.afterAll(async ({ request }) => {
  try { await stopRunThrowaway(request); } finally { await removeThrowaway(request); }
});

const SHOTS = process.env.LIVE_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

/** Start or stop the throwaway as another client would (202). */
async function run(request: APIRequestContext, op: 'start' | 'stop'): Promise<void> {
  const r = await request.post(`/api/v1/orchestration/${op}`, { data: JSON.stringify(t!.workflow.id), headers: { 'Content-Type': 'application/json' } });
  expect(r.status(), `POST ${op}: ${await r.text()}`).toBe(202);
}

/** Every liveness GET the page makes from now on (the fallback poll's two endpoints). */
function pollsOf(page: Page): Request[] {
  const polls: Request[] = [];
  page.on('request', (r) => { if (/\/api\/v1\/(orchestration\/live|processors\/liveness)$/.test(new URL(r.url()).pathname)) polls.push(r); });
  return polls;
}

/** Output's lines for one workflow, as "<name> <text>". */
async function linesOf(page: Page, name: string): Promise<string[]> {
  return (await outputLines(page)).evaluateAll((els, n) => els
    .filter((el) => el.querySelector('b')?.textContent === n)
    .map((el) => `${n} ${[...el.childNodes].filter((x) => x.nodeType === 3).map((x) => x.textContent).join('').trim()}`), name);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

test('a workflow started and stopped elsewhere: its hidden tab, its hub, the picker dot and Output follow, with no polling', async ({ page, request }) => {
  test.skip(t === null, 'no live processor without schemas in the cluster to start a throwaway on');
  const wf = t!.workflow;
  const [other] = await liveWorkflows(request, 1);
  await openWorkflow(page, wf);
  const panel = documentPanel(page, wf);
  const status = panel.getByLabel('Status');
  await expect(status).toHaveText('■ stopped', { timeout: 15_000 });
  // another workflow in front: the throwaway's tab is hidden behind it
  await openWorkflow(page, other!);
  await expect(panel).toHaveClass(/\bbg\b/);
  await expect(page.getByRole('status', { name: 'Live updates' })).toHaveCount(0);
  const polls = pollsOf(page);

  await run(request, 'start');
  await expect(status).toHaveText('▶ running', { timeout: 15_000 });
  await expect(panel).toHaveClass(/\bbg\b/);   // still hidden: the push reached it there
  await expect(panel.locator('.wf').first()).toHaveAttribute('data-started', 'true');
  await expect.poll(() => linesOf(page, wf.name)).toEqual([`${wf.name} running`]);

  // the picker marks it running (real mouse: Workspace › Load workflow…)
  await page.getByRole('menuitem', { name: 'Workspace' }).click();
  await page.getByRole('menuitem', { name: /Load workflow/ }).click();
  await page.getByRole('textbox', { name: 'Search workflows' }).fill(wf.label);
  const option = page.getByRole('option', { name: new RegExp(wf.label) });
  await expect(option.getByRole('img', { name: 'running' })).toBeVisible();
  await expect(option).toHaveAccessibleName(/running/);
  await shot(page, '1-picker-running-dot');
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Search workflows' }).waitFor({ state: 'detached' });

  await run(request, 'stop');
  await expect(status).toHaveText('■ stopped', { timeout: 15_000 });
  await expect.poll(() => linesOf(page, wf.name)).toEqual([`${wf.name} running`, `${wf.name} stopped`]);
  await shot(page, '2-output-running-stopped');
  // nothing polled: every change came over the hub
  expect(polls.map((r) => r.url())).toEqual([]);
});

test('the hub forced down: the mark shows and one poll every 5 s keeps the status; back up, the mark goes and polling stops', async ({ page, request }) => {
  test.skip(t === null, 'no live processor without schemas in the cluster to start a throwaway on');
  let blocked = false;
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/api\/hubs\/liveness/, (ws) => {
    if (blocked) { void ws.close(); return; }
    ws.connectToServer();
    sockets.push(ws);
  });
  await page.reload();
  const wf = t!.workflow;
  await openWorkflow(page, wf);
  const status = documentPanel(page, wf).getByLabel('Status');
  const mark = page.getByRole('status', { name: 'Live updates' });
  await expect(status).toHaveText('■ stopped', { timeout: 15_000 });
  await expect(mark).toHaveCount(0);
  const polls = pollsOf(page);

  // down: every connection is closed, and every new one refused
  blocked = true;
  for (const s of sockets.splice(0)) await s.close();
  await expect(mark).toHaveText('live updates reconnecting', { timeout: 10_000 });
  await expect.poll(() => polls.filter((r) => r.url().endsWith('/orchestration/live')).length, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
  const live = polls.filter((r) => r.url().endsWith('/orchestration/live')).map((r) => r.timing().startTime);
  // one app-wide poll, about 5 s apart
  expect(live[1]! - live[0]!).toBeGreaterThan(4000);
  await shot(page, '3-hub-down-reconnecting');

  // a start while the hub is down still shows, from the poll
  await run(request, 'start');
  await expect(status).toHaveText('▶ running', { timeout: 20_000 });

  // up again: the mark goes, a snapshot replaces what the polls said, and polling stops
  blocked = false;
  await expect(mark).toHaveCount(0, { timeout: 45_000 });
  await page.waitForTimeout(500);
  const after = polls.length;
  await page.waitForTimeout(6000);
  expect(polls.length).toBe(after);
  await run(request, 'stop');
  await expect(status).toHaveText('■ stopped', { timeout: 15_000 });
  await expect.poll(() => linesOf(page, wf.name)).toEqual([`${wf.name} running`, `${wf.name} stopped`]);
  await shot(page, '4-hub-back');
});
