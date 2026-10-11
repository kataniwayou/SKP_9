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
/** The /ai route answering `content` as the model's message (or an HTTP status), recording what was sent. */
async function mockModel(page: Page, answer: { content?: string; status?: number }): Promise<unknown[]> {
  const sent: unknown[] = [];
  await page.route('**/ai/chat/completions', async (route: Route) => {
    sent.push(route.request().postDataJSON());
    if (answer.status) await route.fulfill({ status: answer.status, contentType: 'application/json', body: '{"error":"no"}' });
    else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer.content } }] }) });
  });
  return sent;
}
const lastLine = async (page: Page) => (await pane(page, 'Output')).locator('.outl').last();

test('a drawing that keeps every relation is applied as one step: the block moves, Output says so, Ctrl+Z puts it back', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const before = await posOf(panel, t.stepBId);
  const to = [before[0] + 64, before[1] + 160];
  const sent = await mockModel(page, { content: JSON.stringify({ blocks: { [t.stepBId]: { x: to[0], y: to[1] } } }) });
  // the button: only a wand (2026-10-11), named "AI drawing"
  await expect(panel.getByRole('button', { name: 'AI drawing', exact: true })).toHaveText('');
  await expect(panel.getByRole('button', { name: 'AI drawing', exact: true }).locator('svg')).toHaveCount(1);
  await panel.getByRole('button', { name: 'AI drawing', exact: true }).click();
  await expect.poll(() => posOf(panel, t.stepBId)).toEqual(to);
  const line = await lastLine(page);
  await expect(line).toContainText('AI drawing applied: 1 block moved, 0 wires reshaped');
  await expect(line).not.toHaveClass(/err/);
  await expect(page.getByText('● design draft')).toBeVisible();
  // only a valid saved workflow is drawn (2026-10-11): with the drawing unsaved the wand is off and says why
  const wand = panel.getByRole('button', { name: 'AI drawing', exact: true });
  await expect(wand).toBeDisabled();
  await expect(wand).toHaveAttribute('data-tip', 'Save your changes first');
  // what went to the model: kimi-k3, the rules, the graph with this workflow's steps
  const body = sent[0] as { model: string; messages: { role: string; content: string }[] };
  expect(body.model).toBe('kimi-k3');
  expect(body.messages[0]!.content).toContain('1. The drawing must mean the workflow');
  expect(body.messages[1]!.content).toContain(t.stepBId);
  // one history step
  await panel.locator('.studio-canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(() => posOf(panel, t.stepBId)).toEqual(before);
  // back to the saved drawing: the wand is on again
  await expect(wand).toBeEnabled();
});

test('an answer naming a wire the design does not have (a dropped or invented wire) is refused in red; nothing changes', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const before = await posOf(panel, t.stepBId);
  await mockModel(page, { content: JSON.stringify({ blocks: { [t.stepBId]: { x: before[0] + 64, y: before[1] } }, wires: { [`${t.stepId}->gone`]: { bends: null } } }) });
  await panel.getByRole('button', { name: 'AI drawing', exact: true }).click();
  const line = await lastLine(page);
  await expect(line).toContainText('AI drawing not applied: unknown wire');
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
