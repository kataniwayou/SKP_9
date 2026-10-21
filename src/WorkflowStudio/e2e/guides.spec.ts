import type { Locator, Page } from '@playwright/test';
import { centreOf, documentPanel, expect, flowToPage, node, openWorkflow, test, zoomOf, type Pt } from './studio';
import { createCircuitThrowaway, removeThrowaway, type CircuitThrowaway } from './throwaway';

// Plan 10 phase 1 (Visio is the authority, 2026-10-21): the dynamic grid, with the real mouse. Every component (steps,
// the hub, the cache) snaps to alignment and to equal gaps within 12 screen px at any zoom, on the canvas and dropped
// from the Toolbox; the guides are Visio's green. The workflow is the circuit throwaway (`e2e-9-…`: wf -> a, a -> b,
// a -> d (Failed), b -> c; one cache); nothing is saved.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const GREEN = 'rgb(91, 200, 91)';
const tile = (page: Page, tool: string) => page.locator(`[data-pane="toolbox"] .tb-tile[data-tool="${tool}"]`).first();
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}
/** A block's box in flow coordinates, from its transform. */
const boxOf = (panel: Locator, id: string) => node(panel, id).evaluate((el) => {
  const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec((el as HTMLElement).style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]), w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight };
});
/** Where a block is grabbed: a step by its name in the caption, the hub and a cache by their centre. */
const grip = (panel: Locator, id: string) => (id === 'wf' || id.startsWith('cache:') ? centreOf(node(panel, id)) : centreOf(node(panel, id).locator('.nx-sn')));
/** Presses `from` and moves the real mouse by (dx, dy) screen px in steps; released unless `hold`. */
async function dragBy(page: Page, from: Pt, dx: number, dy: number, hold = false): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 3, from.y + dy / 3, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await frames(page);
  if (!hold) { await page.mouse.up(); await frames(page); }
}
const guideCount = (panel: Locator) => panel.locator('line.design-guide').count();
const gapCount = (panel: Locator) => panel.locator('g.design-gap').count();

test('equal gaps: d dragged 10 px past the gap its row repeats (hub-a, a-d) snaps back to it, the arrows shown while held', async ({ page }) => {
  const panel = await open(page);
  const hub = await boxOf(panel, 'wf'), a = await boxOf(panel, t.a), d = await boxOf(panel, t.d);
  // the row: the hub, a and d overlap in height, side by side; a-d repeats hub-a's gap (the automatic layout's).
  // Only a row's own pairs count (Visio, measured: a pair offset up or down does not)
  expect(d.x - (a.x + a.w)).toBe(a.x - (hub.x + hub.w));
  await dragBy(page, await grip(panel, t.d), 10, 0, true);
  expect(await gapCount(panel)).toBeGreaterThanOrEqual(2);
  const strokes = await panel.locator('g.design-gap line').evaluateAll((els) => els.map((e) => getComputedStyle(e).stroke));
  expect(new Set(strokes)).toEqual(new Set([GREEN]));
  await page.mouse.up();
  await frames(page);
  expect((await boxOf(panel, t.d)).x).toBe(d.x);
  expect(await gapCount(panel)).toBe(0);
});

test('alignment within 12 screen px at 100% and at 200%: 10 px off snaps level, a guide 16 px away does not', async ({ page }) => {
  const panel = await open(page);
  const c = await boxOf(panel, t.c);
  // c 10 px below its row: snaps back level with b (their tops, centres and processor middles)
  await dragBy(page, await grip(panel, t.c), 0, 10, true);
  expect(await guideCount(panel)).toBeGreaterThan(0);
  const colours = await panel.locator('line.design-guide').evaluateAll((els) => els.map((e) => getComputedStyle(e).stroke));
  expect(new Set(colours)).toEqual(new Set([GREEN]));
  await page.mouse.up();
  await frames(page);
  expect((await boxOf(panel, t.c)).y).toBe(c.y);
  // 48 flow px down: its nearest guide (processor middle against the row's bottom edge) 16 flow px away, beyond the reach
  const z = await zoomOf(panel);
  await dragBy(page, await grip(panel, t.c), 0, 48 * z);
  expect((await boxOf(panel, t.c)).y).not.toBe(c.y);
  await page.keyboard.press('Control+z');
  // zoomed to 200% at c (Ctrl+wheel follows the pointer), the same 10 screen px still snaps
  const at = await grip(panel, t.c);
  for (let i = 0; i < 30 && (await zoomOf(panel)) < 2; i++) {
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await frames(page);
  }
  expect(await zoomOf(panel)).toBeGreaterThanOrEqual(1.9);
  await dragBy(page, await grip(panel, t.c), 0, 10);
  expect((await boxOf(panel, t.c)).y).toBe(c.y);
});

test("the cache lines up with a step, and a step with the cache", async ({ page }) => {
  const panel = await open(page);
  const cache = `cache:${t.cacheId}`;
  const c = await boxOf(panel, t.c), k = await boxOf(panel, cache);
  const z = await zoomOf(panel);
  // the cache brought out right of c, its top 6 screen px below c's: snaps level with c, a guide while held
  await dragBy(page, await grip(panel, cache), (c.x + c.w + 200 - k.x) * z, (c.y - k.y) * z + 6, true);
  expect(await guideCount(panel)).toBeGreaterThan(0);
  await page.mouse.up();
  await frames(page);
  const k1 = await boxOf(panel, cache);
  expect(k1.y).toBe(c.y);
  // the cache parked alone far below, then c brought beside it, its top 6 screen px off the cache's: the cache is the
  // only block at that height
  await dragBy(page, await grip(panel, cache), 0, 640 * z);
  const k2 = await boxOf(panel, cache);
  await dragBy(page, await grip(panel, t.c), (k2.x + k2.w + 200 - c.x) * z, (k2.y - c.y) * z + 6);
  expect((await boxOf(panel, t.c)).y).toBe(k2.y);
});

test("the hub is a reference: a step's centre 6 screen px off the hub's centre snaps level with it", async ({ page }) => {
  const panel = await open(page);
  const hub = await boxOf(panel, 'wf'), d = await boxOf(panel, t.d);
  const z = await zoomOf(panel);
  const cy = hub.y + hub.h / 2;
  await dragBy(page, await grip(panel, t.d), 0, (cy - (d.y + d.h / 2)) * z + 6);
  const d2 = await boxOf(panel, t.d);
  expect(d2.y + d2.h / 2).toBe(cy);
});

test("a Toolbox empty step dropped 8 screen px off c's left edge lands lined up with it, the guides shown while held", async ({ page }) => {
  const panel = await open(page);
  const c = await boxOf(panel, t.c);
  // zoomed out twice for room on the canvas (the reach is in screen px, so 8 px means the same at any zoom); below c, its
  // left edge 8 screen px right of c's (the ghost and the landing box are centred on the pointer)
  await panel.getByRole('button', { name: 'Zoom out' }).click();
  await panel.getByRole('button', { name: 'Zoom out' }).click();
  await frames(page);
  const to = await flowToPage(panel, [c.x + c.w / 2, c.y + c.h + 240]);
  const canvasBox = (await panel.locator('.react-flow').boundingBox())!;
  expect(to.y).toBeLessThan(canvasBox.y + canvasBox.height - 80);
  const from = await centreOf(tile(page, 'step'));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 5, { steps: 3 });
  await page.mouse.move(to.x + 8, to.y, { steps: 12 });
  await frames(page);
  expect(await guideCount(panel)).toBeGreaterThan(0);
  const before = await panel.locator('.react-flow__node-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
  await page.mouse.up();
  await frames(page);
  const made = (await panel.locator('.react-flow__node-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).filter((id) => !before.includes(id));
  expect(made).toHaveLength(1);
  expect((await boxOf(panel, made[0]!)).x).toBe(c.x);
});

test('Escape while held leaves no guide and no draft; dragged out and back, no draft either', async ({ page }) => {
  const panel = await open(page);
  const d0 = await boxOf(panel, t.d);
  const from = await grip(panel, t.d);
  await dragBy(page, from, 10, 0, true);
  expect(await gapCount(panel)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await frames(page);
  expect(await guideCount(panel)).toBe(0);
  expect(await gapCount(panel)).toBe(0);
  await expect(page.getByText('● design draft')).toHaveCount(0);
  // out and back to the start's place in the drawing (found on screen again: the view may refit). React Flow measures a
  // drag from where it crossed its 2 px start, so the first step is 3 px: the block's lag stays inside one grid step
  const z0 = await zoomOf(panel);
  const top = await flowToPage(panel, [0, 0]);
  const gripFlow: [number, number] = [(from.x - top.x) / z0, (from.y - top.y) / z0];
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 3, from.y);
  await page.mouse.move(from.x - 150, from.y + 100, { steps: 8 });
  const back = await flowToPage(panel, gripFlow);
  await page.mouse.move(back.x, back.y, { steps: 8 });
  await page.mouse.up();
  await frames(page);
  expect((await boxOf(panel, t.d)).y).toBe(d0.y);
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('the block follows the pointer from the press, with no lag (a 12 px first step, then 60 px across and 200 down)', async ({ page }) => {
  const panel = await open(page);
  const d0 = await boxOf(panel, t.d);
  const z = await zoomOf(panel);
  const from = await grip(panel, t.d);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y);
  await page.mouse.move(from.x + 60, from.y + 200, { steps: 10 });
  await frames(page);
  const held = await boxOf(panel, t.d);
  // within half a grid step (and whatever guide it may snap to: none lies in reach of this spot)
  expect(Math.abs((held.x - d0.x) - 60 / z)).toBeLessThanOrEqual(4);
  expect(Math.abs((held.y - d0.y) - 200 / z)).toBeLessThanOrEqual(4);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});
