import type { Locator, Page, Route } from '@playwright/test';
import { documentPanel, openWorkflow, pane } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// AI drawing (the user's design, 2026-10-11), with the real mouse: the toolbar button asks the model through the studio's
// own /ai route — mocked here, deterministic, so no model is called and no key is needed — and the studio applies the
// drawing only when every relation between the steps stays the same. Only this run's throwaway is opened; nothing saved.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const posOf = (panel: Locator, id: string) => panel.locator(`.react-flow__node[data-id="${id}"]`).evaluate((e) => {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec((e as HTMLElement).style.transform)!;
  return [Number(m[1]), Number(m[2])] as [number, number];
});
/**
 * The /ai route answering `content` as the model's message (or an HTTP status), recording what was sent; a list answers
 * each call in turn (the last one repeats). Streamed (2026-10-11): an event stream as Kimi sends it, after `delayMs`.
 */
async function mockModel(page: Page, answer: { content?: string | string[]; status?: number; delayMs?: number }): Promise<unknown[]> {
  const sent: unknown[] = [];
  await page.route('**/ai/chat/completions', async (route: Route) => {
    sent.push(route.request().postDataJSON());
    if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
    if (answer.status) { await route.fulfill({ status: answer.status, contentType: 'application/json', body: '{"error":"no"}' }); return; }
    const all = Array.isArray(answer.content) ? answer.content : [answer.content ?? ''];
    const content = all[Math.min(sent.length - 1, all.length - 1)]!;
    const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const half = Math.floor(content.length / 2);
    const body = ev({ choices: [{ delta: { reasoning_content: 'thinking' } }] }) + ev({ choices: [{ delta: { content: content.slice(0, half) } }] })
      + ev({ choices: [{ delta: { content: content.slice(half) } }] }) + 'data: [DONE]\n\n';
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  return sent;
}
const lastLine = async (page: Page) => (await pane(page, 'Output')).locator('.outl').last();

test('a drawing that keeps every relation is applied as one step: the block moves, Output says so, Ctrl+Z puts it back', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const before = await posOf(panel, t.stepBId);
  const to = [before[0] + 64, before[1] + 160];
  const sent = await mockModel(page, { content: JSON.stringify({ blocks: { [t.stepBId]: { x: to[0], y: to[1] } } }), delayMs: 2500 });
  // the button: only a wand (2026-10-11), named "AI drawing"
  await expect(panel.getByRole('button', { name: 'AI drawing', exact: true })).toHaveText('');
  await expect(panel.getByRole('button', { name: 'AI drawing', exact: true }).locator('svg')).toHaveCount(1);
  await panel.getByRole('button', { name: 'AI drawing', exact: true }).click();
  // while the model thinks: a spinner and Cancel with the seconds counting
  await expect(panel.getByRole('button', { name: 'AI drawing: cancel' })).toHaveText(/Cancel · [1-9] s/);
  await expect.poll(() => posOf(panel, t.stepBId)).toEqual(to);
  const line = await lastLine(page);
  await expect(line).toContainText('AI drawing applied: 1 block moved');
  await expect(line).not.toHaveClass(/err/);
  await expect(page.getByText('● design draft')).toBeVisible();
  // only a valid saved workflow is drawn (2026-10-11): with the drawing unsaved the wand is off and says why
  const wand = panel.getByRole('button', { name: 'AI drawing', exact: true });
  await expect(wand).toBeDisabled();
  await expect(wand).toHaveAttribute('data-tip', 'Save your changes first');
  // what went to the model: kimi-k3, the rules, the graph with this workflow's steps
  const body = sent[0] as { model: string; stream: boolean; messages: { role: string; content: string }[] };
  expect(body).toMatchObject({ model: 'kimi-k3', stream: true });
  expect(sent).toHaveLength(1);
  expect(body.messages[0]!.content).toContain('1. The drawing must mean the workflow');
  expect(body.messages[1]!.content).toContain(t.stepBId);
  // one history step
  await panel.locator('.studio-canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(() => posOf(panel, t.stepBId)).toEqual(before);
  // back to the saved drawing: the wand is on again
  await expect(wand).toBeEnabled();
});

test('a refused answer gets one correction round: the model hears why, and its corrected drawing is applied', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const before = await posOf(panel, t.stepBId);
  const to = [before[0] + 64, before[1]];
  const sent = await mockModel(page, { content: [
    JSON.stringify({ blocks: { [t.stepBId]: { x: to[0], y: to[1] } }, wires: { [`${t.stepId}->gone`]: {} } }),
    JSON.stringify({ blocks: { [t.stepBId]: { x: to[0], y: to[1] } } }),
  ] });
  await panel.getByRole('button', { name: 'AI drawing', exact: true }).click();
  await expect.poll(() => posOf(panel, t.stepBId)).toEqual(to);
  expect(sent).toHaveLength(2);
  const fix = (sent[1] as { messages: { role: string; content: string }[] }).messages;
  expect(fix.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(fix[3]!.content).toContain('unknown wire');
  const out = (await pane(page, 'Output')).locator('.outl');
  await expect(out.filter({ hasText: 'asking kimi-k3 once to correct it' })).toHaveCount(1);
  await expect(out.last()).toContainText('AI drawing applied: 1 block moved');
});

test('an answer refused twice (a dropped or invented wire, then again) is red; nothing changes', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const before = await posOf(panel, t.stepBId);
  const sent = await mockModel(page, { content: JSON.stringify({ blocks: { [t.stepBId]: { x: before[0] + 64, y: before[1] } }, wires: { [`${t.stepId}->gone`]: {} } }) });
  await panel.getByRole('button', { name: 'AI drawing', exact: true }).click();
  const line = await lastLine(page);
  await expect(line).toContainText('AI drawing not applied: unknown wire');
  expect(sent).toHaveLength(2);
  await expect(line).toHaveClass(/err/);
  expect(await posOf(panel, t.stepBId)).toEqual(before);
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('the model refusing the key (HTTP 401) is red: AI drawing is not configured; nothing changes', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await mockModel(page, { status: 401 });
  await panel.getByRole('button', { name: 'AI drawing', exact: true }).click();
  const line = await lastLine(page);
  await expect(line).toContainText('AI drawing is not configured: the model refused the key (HTTP 401)');
  await expect(line).toHaveClass(/err/);
  await expect(panel.getByRole('button', { name: 'AI drawing', exact: true })).toBeEnabled();
  await expect(page.getByText('● design draft')).toHaveCount(0);
});
