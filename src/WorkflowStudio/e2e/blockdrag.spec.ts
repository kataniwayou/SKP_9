import type { Locator, Page } from '@playwright/test';
import { centreOf, documentPanel, expect, node, openWorkflow, test, wirePoints, zoomOf } from './studio';
import { createCircuitThrowaway, removeThrowaway, type CircuitThrowaway } from './throwaway';

// Plan 10 phase 4 (Visio is the authority, 2026-10-22): dragging a block, with the real mouse. Visio's held drag
// (`shots/ui-B-dragged-down-held.png`): the block and its wires stay put; a faded copy with a light-blue dashed outline
// follows the pointer, with the guides and equal gaps; the wires reroute on release. Escape puts everything back.
// The workflow is the circuit throwaway (`e2e-9-…`: wf -> a, a -> b, a -> d (Failed), b -> c; one cache); nothing is saved.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

type At = { x: number; y: number };
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
const cursorAt = (page: Page, q: At) => page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, q);
const copy = (panel: Locator, id: string) => node(panel, `copy:${id}`);
/** A block's top left in flow coordinates, from its transform. */
const topLeft = (el: Locator): Promise<At> => el.evaluate((e) => {
  const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec((e as HTMLElement).style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]) };
});

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  for (let i = 0; i < 2; i++) await panel.getByRole('button', { name: 'Zoom out' }).click();
  await frames(page);
  return panel;
}
/** Presses on step `id`'s name and moves the real mouse by (dx, dy) flow px, holding it; where it is then. */
async function hold(page: Page, panel: Locator, id: string, dx: number, dy: number): Promise<At> {
  const z = await zoomOf(panel), from = await centreOf(node(panel, id).locator('.nx-sn'));
  const to = { x: from.x + dx * z, y: from.y + dy * z };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await frames(page);
  return to;
}

test("held: the block and its wires stay put; a faded copy with a light-blue dashed outline follows; the cursor is Visio's move", async ({ page }) => {
  const panel = await open(page);
  const b0 = await topLeft(node(panel, t.b));
  const into = await wirePoints(panel, `${t.a}->${t.b}`), out = await wirePoints(panel, `${t.b}->${t.c}`);
  const at = await hold(page, panel, t.b, 160, 240);
  // the block itself has not moved, and neither has any wire of it
  expect(await topLeft(node(panel, t.b))).toEqual(b0);
  expect(await wirePoints(panel, `${t.a}->${t.b}`)).toEqual(into);
  expect(await wirePoints(panel, `${t.b}->${t.c}`)).toEqual(out);
  // the copy is where the block would land, on the grid, faded and outlined dashed in light blue
  await expect(copy(panel, t.b)).toHaveCount(1);
  const c = await topLeft(copy(panel, t.b));
  expect(c.x - b0.x).toBe(160);
  expect(c.y - b0.y).toBe(240);
  const look = await copy(panel, t.b).evaluate((e) => { const s = getComputedStyle(e); return { opacity: Number(s.opacity), style: s.outlineStyle, color: s.outlineColor, events: s.pointerEvents }; });
  expect(look.opacity).toBeLessThan(1);
  expect(look.style).toBe('dashed');
  expect(look.color).toBe('rgb(102, 178, 255)');
  expect(look.events).toBe('none');
  expect(await cursorAt(page, at)).toBe('move');
  await panel.screenshot({ path: 'test-results/blockdrag-held.png' });
  // released: the block lands where the copy was, the copy is gone and the wires are rerouted to it
  await page.mouse.up();
  await frames(page);
  await expect(copy(panel, t.b)).toHaveCount(0);
  expect(await topLeft(node(panel, t.b))).toEqual(c);
  const after = await wirePoints(panel, `${t.a}->${t.b}`);
  expect(after.at(-1)![0]).toBe(c.x);
  expect(after).not.toEqual(into);
});

test('Escape while held: the copy goes, nothing moved, the release makes no step', async ({ page }) => {
  const panel = await open(page);
  const b0 = await topLeft(node(panel, t.b));
  const into = await wirePoints(panel, `${t.a}->${t.b}`);
  await hold(page, panel, t.b, 160, 240);
  await expect(copy(panel, t.b)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await frames(page);
  await expect(copy(panel, t.b)).toHaveCount(0);
  await page.mouse.up();
  await frames(page);
  expect(await topLeft(node(panel, t.b))).toEqual(b0);
  expect(await wirePoints(panel, `${t.a}->${t.b}`)).toEqual(into);
  await expect(panel.getByRole('button', { name: /Undo/ })).toBeDisabled();
});
