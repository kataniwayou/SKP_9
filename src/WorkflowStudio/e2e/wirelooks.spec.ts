import type { Locator, Page } from '@playwright/test';
import {
  blocks, centreOf, documentPanel, dropOpen, edge, endSquare, expect, flowToPage, node, openWorkflow, pickWire, pressTo, squareOn, test, upright, zoomOf, type Pt,
} from './studio';
import { createCircuitThrowaway, removeThrowaway, type CircuitThrowaway } from './throwaway';

// Plan 10 phase 2 (Visio is the authority, 2026-10-21): a wire's looks and feedback, with the real mouse. A picked wire's
// glued ends are green dots, open ends hollow; a held end outlines the block it would glue to in green, with a green
// landing square, within 10 screen px of a side; the dragged wire stays put, faded, under a dashed preview until
// release; a dragged run snaps to a block edge within 12 screen px and shows the guide; blocks take the four-way arrow,
// a placed end the crosshair. The workflow is the circuit throwaway (`e2e-9-…`: wf -> a, a -> b, a -> d (Failed),
// b -> c; one cache); nothing is saved.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const GREEN = 'rgb(91, 200, 91)', WHITE = 'rgb(255, 255, 255)';
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
const ab = () => `${t.a}->${t.b}`;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}
const fillOf = (l: Locator) => l.evaluate((e) => getComputedStyle(e).fill);
/** The cursor the page shows at a point: the computed cursor of the element under it. */
const cursorAt = (page: Page, p: Pt) => page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? getComputedStyle(e).cursor : null; }, p);
/** A step's box on the page. */
const pageBox = async (panel: Locator, id: string) => (await node(panel, id).boundingBox())!;
/** A point `out` screen px left of c's input side, 40 flow px below its top: clear of b -> c, which lands at its middle. */
async function besideC(panel: Locator, out: number): Promise<Pt> {
  const b = await pageBox(panel, t.c), z = await zoomOf(panel);
  return { x: b.x - out, y: b.y + 40 * z };
}
const lit = (panel: Locator) => panel.locator('.react-flow__node.drop-ok').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));

test("a picked wire's glued ends are green dots with a dot on each run; dropped open, its end is hollow", async ({ page }) => {
  const panel = await open(page);
  await pickWire(page, panel, ab());
  expect(await fillOf(endSquare(panel, ab(), 'tail'))).toBe(GREEN);
  expect(await fillOf(endSquare(panel, ab(), 'head'))).toBe(GREEN);
  expect(await panel.locator(`.design-wire[data-wire="${ab()}"] .design-handle.seg`).count()).toBeGreaterThan(0);
  await dropOpen(page, panel, async () => { await pickWire(page, panel, ab()); return centreOf(endSquare(panel, ab(), 'head')); });
  await pickWire(page, panel, ab());
  await expect(endSquare(panel, ab(), 'head')).toHaveClass(/open/);
  expect(await fillOf(endSquare(panel, ab(), 'head'))).toBe(WHITE);
  expect(await fillOf(endSquare(panel, ab(), 'tail'))).toBe(GREEN);
});

test('an end held over a step side outlines the step in green with a green landing square there, under the crosshair', async ({ page }) => {
  const panel = await open(page);
  await pickWire(page, panel, ab());
  const at = await besideC(panel, -4);
  await pressTo(page, await centreOf(endSquare(panel, ab(), 'head')), at);
  expect(await lit(panel)).toEqual([t.c]);
  const contact = panel.locator('.design-contact.ok');
  await expect(contact).toHaveCount(1);
  expect(await contact.evaluate((e) => getComputedStyle(e).stroke)).toBe(GREEN);
  // the square sits on c's side, level with the pointer
  const sq = await centreOf(contact), side = (await pageBox(panel, t.c)).x;
  expect(Math.abs(sq.x - side)).toBeLessThan(2);
  expect(Math.abs(sq.y - at.y)).toBeLessThan(6);
  expect(await cursorAt(page, at)).toBe('crosshair');
  await page.mouse.up();
});

test('a held end 9 screen px outside a side is over it; 12 px outside it is not', async ({ page }) => {
  const panel = await open(page);
  await pickWire(page, panel, ab());
  await pressTo(page, await centreOf(endSquare(panel, ab(), 'head')), await besideC(panel, 9));
  expect(await lit(panel)).toEqual([t.c]);
  await page.mouse.move(...Object.values(await besideC(panel, 12)) as [number, number], { steps: 3 });
  await frames(page);
  expect(await lit(panel)).toEqual([]);
  await expect(panel.locator('.design-contact.ok')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('while held, the wire stays put faded under a dashed preview; Escape puts everything back', async ({ page }) => {
  const panel = await open(page);
  const path = edge(panel, ab()).locator('path.w').first();
  const before = await path.getAttribute('d');
  await pickWire(page, panel, ab());
  await pressTo(page, await centreOf(endSquare(panel, ab(), 'head')), await besideC(panel, -4));
  await expect(edge(panel, ab()).locator('g.wire.faded')).toHaveCount(1);
  // at 45 % (plan 10's constraint)
  expect(await edge(panel, ab()).locator('g.wire.faded').evaluate((e) => getComputedStyle(e).opacity)).toBe('0.45');
  expect(await path.getAttribute('d')).toBe(before);
  const ghost = panel.locator('path.design-ghost');
  await expect(ghost).toHaveCount(1);
  expect(await ghost.evaluate((e) => e.getAttribute('stroke-dasharray'))).toMatch(/\d/);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await frames(page);
  await expect(edge(panel, ab()).locator('g.wire.faded')).toHaveCount(0);
  await expect(ghost).toHaveCount(0);
  expect(await path.getAttribute('d')).toBe(before);
  await pickWire(page, panel, ab());
  expect(await fillOf(endSquare(panel, ab(), 'head'))).toBe(GREEN);
});

test("a dragged run snaps to a block edge 8 screen px away and shows Visio's guide while held", async ({ page }) => {
  const panel = await open(page);
  // a -> b's upright run sits in the gap between a's right side and b's (and d's) left: lines it would lie along, which
  // it may not keep. The cache is brought under that gap, its left edge there and clear of the run, and the canvas zoomed in
  const run0 = await upright(panel, ab());
  const cache = `cache:${t.cacheId}`;
  const k0 = (await blocks(panel)).find((b) => b.w === 160)!;
  let z = await zoomOf(panel);
  const grab = await centreOf(node(panel, cache));
  await pressTo(page, grab, { x: grab.x + (run0.x - 8 - k0.x) * z, y: grab.y + (run0.hi + 160 - k0.y) * z });
  await page.mouse.up();
  await frames(page);
  const at = await flowToPage(panel, [run0.x, (run0.lo + run0.hi) / 2]);
  for (let i = 0; i < 30 && (await zoomOf(panel)) < 1.4; i++) {
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await frames(page);
  }
  z = await zoomOf(panel);
  const run = await upright(panel, ab());
  const target = (await blocks(panel)).find((b) => b.w === 160)!.x;
  const others = (await blocks(panel)).filter((b) => b.w !== 160).flatMap((b) => [b.x, b.x + b.w / 2, b.x + b.w]);
  // the pointer 8 screen px left of the edge: no other block line within the 12 px reach of it
  const want = target - 8 / z;
  expect(others.every((x) => Math.abs(x - want) > 12 / z), JSON.stringify({ target, z, others })).toBe(true);
  await pickWire(page, panel, ab());
  const from = await squareOn(panel, ab(), run);
  await pressTo(page, from, { x: from.x + (want - run.x) * z, y: from.y });
  const guide = panel.locator('line.design-guide.run');
  await expect(guide).toHaveCount(1);
  expect(Number(await guide.getAttribute('x1'))).toBe(target);
  await page.mouse.up();
  await frames(page);
  await expect(guide).toHaveCount(0);
  await expect.poll(async () => (await upright(panel, ab())).x).toBe(target);
});

test('a block shows the four-way arrow in design mode', async ({ page }) => {
  const panel = await open(page);
  const at = await centreOf(node(panel, t.b).locator('.nx-sn'));
  await page.mouse.move(at.x, at.y);
  expect(await cursorAt(page, at)).toBe('move');
});
