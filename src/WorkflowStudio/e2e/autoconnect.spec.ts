import type { Locator, Page } from '@playwright/test';
import { box, documentPanel, emptySpot, expect, newWires, node, openWorkflow, test, wirePoints, zoomOf, type Pt } from './studio';
import { createCircuitThrowaway, removeThrowaway, type CircuitThrowaway } from './throwaway';

// Plan 10 phase 6 (spec §4.8): Visio's AutoConnect arrows, with the real mouse (measured: `scripts/ui9.ps1`). Hovered, a
// block shows a light-blue triangle 24 screen px off each side that has no wire; a click adds an empty step one layout
// gap (128) that way, wired, picked; a step already on that spot is wired instead. The workflow is the circuit throwaway
// (`e2e-9-…`: wf -> a, a -> b, a -> d (Failed), b -> c; one cache); nothing is saved.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
const stepIds = (panel: Locator) => panel.locator('.react-flow__node-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!));
const topLeft = (el: Locator): Promise<Pt> => el.evaluate((e) => {
  const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec((e as HTMLElement).style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]) };
});
const arrowsOn = (panel: Locator, id: string) => node(panel, id).locator('.nx-ac').evaluateAll((els) => els.map((e) => e.getAttribute('data-dir')));
/** An arrow's triangle centre on the page (its ::after box). */
const arrowAt = (panel: Locator, id: string, dir: string): Promise<Pt> => node(panel, id).locator(`.nx-ac[data-dir="${dir}"]`).evaluate((e) => {
  const r = e.getBoundingClientRect(), s = getComputedStyle(e, '::after');
  // the computed lengths are the canvas's own px: on screen they are scaled by the zoom (the node's size there)
  const n = e.closest('.react-flow__node') as HTMLElement;
  const k = n.getBoundingClientRect().width / n.offsetWidth;
  const left = parseFloat(s.left) * k, top = parseFloat(s.top) * k, right = parseFloat(s.right) * k, bottom = parseFloat(s.bottom) * k;
  const w = parseFloat(s.width) * k, h = parseFloat(s.height) * k;
  const x = Number.isNaN(left) ? r.left - right - w / 2 : r.left + left + w / 2;
  const y = Number.isNaN(top) ? r.top - bottom - h / 2 : r.top + top + h / 2;
  return { x, y };
});

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  for (let i = 0; i < 2; i++) await panel.getByRole('button', { name: 'Zoom out' }).click();
  await frames(page);
  return panel;
}
/** Hovers block `id`'s middle, then its `dir` arrow. */
async function toArrow(page: Page, panel: Locator, id: string, dir: string): Promise<Pt> {
  const b = await box(node(panel, id));
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await frames(page);
  const a = await arrowAt(panel, id, dir);
  await page.mouse.move(a.x, a.y, { steps: 6 });
  await frames(page);
  return a;
}

test("a hovered step shows Visio's arrows on its free sides, 24 screen px out; a click on the right one adds the next step one gap right, wired and picked; one Undo takes it back", async ({ page }) => {
  const panel = await open(page);
  // c: its input is wired (b -> c), its output free: right, up and down, no left
  expect(await arrowsOn(panel, t.c)).toEqual(['right', 'up', 'down']);
  const c0 = await topLeft(node(panel, t.c)), cb = await box(node(panel, t.c)), z = await zoomOf(panel);
  const a = await toArrow(page, panel, t.c, 'right');
  expect(Math.abs(a.x - (cb.x + cb.width) - 24)).toBeLessThan(1.5);
  expect(Math.abs(a.y - (cb.y + 96 * z))).toBeLessThan(1.5);
  expect(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, a)).toBe('pointer');
  // held: where the new step will land, dashed
  await expect(panel.locator('.design-tool-landing')).toHaveCount(1);
  await panel.screenshot({ path: 'test-results/autoconnect-hover.png' });
  const before = await stepIds(panel);
  await page.mouse.click(a.x, a.y);
  await frames(page);
  await expect.poll(async () => (await stepIds(panel)).length).toBe(before.length + 1);
  const made = (await stepIds(panel)).find((id) => !before.includes(id))!;
  expect(await topLeft(node(panel, made))).toEqual({ x: c0.x + 224 + 128, y: c0.y });
  await expect(node(panel, made)).toHaveClass(/studio-pick/);
  await expect(newWires(panel)).toHaveCount(1);
  const w = await wirePoints(panel, (await newWires(panel).first().getAttribute('data-id'))!);
  expect(w[0]![0]).toBe(c0.x + 224);
  expect(w.at(-1)![0]).toBe(c0.x + 224 + 128);
  await panel.screenshot({ path: 'test-results/autoconnect-clicked.png' });
  await panel.getByRole('button', { name: /Undo/ }).click();
  await frames(page);
  expect(await stepIds(panel)).toEqual(before);
  await expect(newWires(panel)).toHaveCount(0);
});

test("a step already on the spot (b, below d): the down arrow wires d to it, no new step; the hub with tails shows no arrow", async ({ page }) => {
  const panel = await open(page);
  expect(await arrowsOn(panel, 'wf')).toEqual([]);
  const before = await stepIds(panel);
  const a = await toArrow(page, panel, t.d, 'down');
  // previewed: b outlined, no landing box
  await expect(node(panel, t.b)).toHaveClass(/drop-ok/);
  await expect(panel.locator('.design-tool-landing')).toHaveCount(0);
  await page.mouse.click(a.x, a.y);
  await frames(page);
  expect(await stepIds(panel)).toEqual(before);
  await expect(newWires(panel)).toHaveCount(1);
  const w = await wirePoints(panel, (await newWires(panel).first().getAttribute('data-id'))!);
  expect(w.at(-1)![0]).toBe((await topLeft(node(panel, t.b))).x);
});

test('dragged to empty canvas, an arrow draws a wire open there, as from the connection point', async ({ page }) => {
  const panel = await open(page);
  const a = await toArrow(page, panel, t.c, 'right');
  const to = await emptySpot(panel);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await frames(page);
  await page.mouse.up();
  await frames(page);
  await expect(newWires(panel)).toHaveCount(1);
  expect((await stepIds(panel)).length).toBe(4);
  void a;
});

test("an arrow taken away under the pointer leaves no landing box behind: a wire drawn from its side (2026-10-22)", async ({ page }) => {
  const panel = await open(page);
  // dragged from the right arrow itself to empty canvas: c's output is wired, its right arrow goes
  await toArrow(page, panel, t.c, 'right');
  await expect(panel.locator('.design-tool-landing')).toHaveCount(1);
  const to = await emptySpot(panel);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await frames(page);
  await expect(newWires(panel)).toHaveCount(1);
  expect(await arrowsOn(panel, t.c)).not.toContain('right');
  await expect(panel.locator('.design-tool-landing')).toHaveCount(0);
  await page.mouse.move(to.x + 40, to.y + 40, { steps: 4 });
  await expect(panel.locator('.design-tool-landing')).toHaveCount(0);

  // a wire from c's connection point whose drag crosses c's up arrow on its way out: nothing is left behind either
  const up = await toArrow(page, panel, t.c, 'up');
  await expect(panel.locator('.design-tool-landing')).toHaveCount(1);
  const port = await box(node(panel, t.c).locator('.nx-port').first());
  await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2, { steps: 6 });
  await page.mouse.down();
  // out over the up arrow and away to empty canvas
  await page.mouse.move(up.x, up.y, { steps: 6 });
  const far = await emptySpot(panel, [to]);
  await page.mouse.move(far.x, far.y, { steps: 12 });
  await page.mouse.up();
  await frames(page);
  await page.mouse.move(far.x + 40, far.y + 40, { steps: 4 });
  await frames(page);
  await expect(panel.locator('.design-tool-landing')).toHaveCount(0);
});
