import type { Locator, Page } from '@playwright/test';
import { blocks, centreOf, documentPanel, dragReading, edge, expect, node, openWorkflow, test, wirePoints, zoomOf } from './studio';
import { createCircuitThrowaway, removeThrowaway, type CircuitThrowaway } from './throwaway';

// Plan 10 phase 3 (Visio is the authority, 2026-10-22): the router, with the real mouse. Blocks are dragged where Visio's
// measured scenes put them and the routes read back as points:
// - a target behind and below turns back through the free band, 64 above it;
// - a block in the way is gone round 64 off it, on its nearer side, and the wire comes back at the target's stub;
// - one net's fan-out shares its trunk, another net leaving the same output a track away;
// - a crossing jumps with an arc on the level run.
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

type P = [number, number];
type Box = { x: number; y: number; w: number; h: number };
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
const STUB = 64;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  // room to move blocks about
  for (let i = 0; i < 2; i++) await panel.getByRole('button', { name: 'Zoom out' }).click();
  await frames(page);
  return panel;
}
/** A block's box in flow coordinates, from its transform. */
const boxOf = (panel: Locator, id: string): Promise<Box> => node(panel, id).evaluate((el) => {
  const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec((el as HTMLElement).style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]), w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight };
});
/** Where a block is grabbed: a step by its name in the caption, a cache by its centre. */
const grip = (panel: Locator, id: string) => (id.startsWith('cache:') ? centreOf(node(panel, id)) : centreOf(node(panel, id).locator('.nx-sn')));
/** Drags block `id` with the real mouse so its top left lands near flow (x, y) (the dynamic grid may snap it); its box then. */
async function moveTo(page: Page, panel: Locator, id: string, x: number, y: number): Promise<Box> {
  const b = await boxOf(panel, id), z = await zoomOf(panel), from = await grip(panel, id);
  const to = { x: from.x + (x - b.x) * z, y: from.y + (y - b.y) * z };
  const r = (await panel.locator('.react-flow').boundingBox())!;
  expect(to.x > r.x && to.x < r.x + r.width && to.y > r.y && to.y < r.y + r.height, `${id} dropped on the canvas`).toBe(true);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await frames(page);
  await page.mouse.up();
  await frames(page);
  return boxOf(panel, id);
}
const out = (b: Box): P => [b.x + b.w, b.y + 96];
const inp = (b: Box): P => [b.x, b.y + 96];
const id = (a: string, b: string) => `${a}->${b}`;
/** Every level run crossed inside by an upright run of another wire: [the level wire, the crossing]. */
async function crossings(panel: Locator): Promise<[string, P][]> {
  const ids = await panel.locator('.react-flow__edge[data-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!).filter((x) => !x.startsWith('tether:')));
  const lines = await Promise.all(ids.map(async (w) => ({ w, pts: await wirePoints(panel, w) })));
  const found: [string, P][] = [];
  for (const h of lines) for (let i = 1; i < h.pts.length; i++) {
    const [a, b] = [h.pts[i - 1]!, h.pts[i]!];
    if (a[1] !== b[1]) continue;
    for (const v of lines) if (v.w !== h.w) for (let j = 1; j < v.pts.length; j++) {
      const [c, d] = [v.pts[j - 1]!, v.pts[j]!];
      if (c[0] !== d[0]) continue;
      const x = c[0], y = a[1];
      if (x - Math.min(a[0], b[0]) >= 8 && Math.max(a[0], b[0]) - x >= 8 && y - Math.min(c[1], d[1]) >= 8 && Math.max(c[1], d[1]) - y >= 8) found.push([h.w, [x, y]]);
    }
  }
  return found;
}

test("a target behind and below: out 64, down to 64 above the target, back across, down 64 before it and in (Visio's U)", async ({ page }) => {
  const panel = await open(page);
  const bottom = Math.max(...(await blocks(panel)).map((k) => k.y + k.h));
  const a = await boxOf(panel, t.a);
  const c = await moveTo(page, panel, t.c, a.x, Math.ceil((bottom + 192) / 8) * 8);
  const b = await boxOf(panel, t.b);
  expect(c.x + c.w).toBeLessThan(b.x);
  expect(c.y).toBeGreaterThanOrEqual(b.y + b.h + 2 * STUB);
  const [sx, sy] = out(b), [tx, ty] = inp(c);
  expect(await wirePoints(panel, id(t.b, t.c))).toEqual([[sx, sy], [sx + STUB, sy], [sx + STUB, c.y - STUB], [tx - STUB, c.y - STUB], [tx - STUB, ty], [tx, ty]]);
  await panel.screenshot({ path: 'test-results/routes-behind-below.png' });
});

test('a block in the way: round it 64 off, hugging it, on its nearer side, back at the target stub (Visio: obstacle)', async ({ page }) => {
  const panel = await open(page);
  const b = await boxOf(panel, t.b);
  const c = await moveTo(page, panel, t.c, b.x + 2 * 352, b.y);
  expect(c.y).toBe(b.y);
  const k = await moveTo(page, panel, `cache:${t.cacheId}`, b.x + b.w + 2 * STUB + 32, b.y + 16);
  const [sx, sy] = out(b), [tx, ty] = inp(c);
  // the straight line is blocked: the cache lies within half the clearance (32) of it
  expect(sy).toBeGreaterThan(k.y - 32);
  expect(sy).toBeLessThan(k.y + k.h + 32);
  const up = k.y - STUB, down = k.y + k.h + STUB;
  const level = sy - up <= down - sy ? up : down;
  expect(await wirePoints(panel, id(t.b, t.c))).toEqual([[sx, sy], [k.x - STUB, sy], [k.x - STUB, level], [tx - STUB, level], [tx - STUB, ty], [tx, ty]]);
  await panel.screenshot({ path: 'test-results/routes-obstacle.png' });
});

// (a fan-in's automatic landings 32 apart are unit tests: a wire drawn onto a step here is a slid end, landing where dropped)
test("one net's fan-out leaves one point and shares its trunk; another net leaves a track (32) away", async ({ page }) => {
  const panel = await open(page);
  const c = await boxOf(panel, t.c);
  // a second wire out of a, into c (Completed, as a -> b is): rule G's same-colour siblings, one net's bus
  await node(panel, t.a).hover();
  // dropped on c's body, left of its middle: its input
  const cb = (await node(panel, t.c).boundingBox())!;
  const said = await dragReading(page, panel, await centreOf(node(panel, t.a).locator('.nx-port')), { x: cb.x + cb.width / 4, y: cb.y + cb.height / 2 });
  expect(said).toBe('connect here');
  const w = (await panel.locator('.react-flow__edge[data-id^="w:"]').last().getAttribute('data-id'))!;
  await frames(page);
  const ab = await wirePoints(panel, id(t.a, t.b)), aw = await wirePoints(panel, w);
  const a = await boxOf(panel, t.a);
  expect(aw[0]).toEqual(ab[0]);
  // a's other net (a -> d, Failed) leaves a track away: the two nets 16 either side of a's processor middle
  const ad = await wirePoints(panel, id(t.a, t.d));
  expect(aw[0]![0]).toBe(a.x + a.w);
  expect(Math.abs(aw[0]![1] - ad[0]![1])).toBe(32);
  expect((aw[0]![1] + ad[0]![1]) / 2).toBe(out(a)[1]);
  expect(aw[1]).toEqual([a.x + a.w + STUB, ab[0]![1]]);
  expect(ab[1]).toEqual(aw[1]);
  // both turn down the one trunk at a's stub
  expect(ab[2]![0]).toBe(a.x + a.w + STUB);
  expect(aw[2]![0]).toBe(a.x + a.w + STUB);
  expect(aw.at(-1)![0]).toBe(c.x);
  await panel.screenshot({ path: 'test-results/routes-fan.png' });
});

test('a crossing jumps: an arc 16 wide on the level run, where an upright of another wire crosses it', async ({ page }) => {
  const panel = await open(page);
  const b = await boxOf(panel, t.b);
  // c two rows down: b -> c turns down at b's stub; d in the band between them, beyond c: a -> d runs level across it
  const c = await moveTo(page, panel, t.c, b.x + 352, b.y + 288);
  await moveTo(page, panel, t.d, c.x + 352, b.y + 128);
  const found = await crossings(panel);
  expect(found.length).toBeGreaterThan(0);
  for (const [w, [x, y]] of found) {
    const d = (await edge(panel, w).locator('path.w').first().getAttribute('d'))!;
    expect(d, `${w} jumps at ${x}, ${y}`).toMatch(new RegExp(`L${x - 8} ${y} A8 8 0 0 1 ${x + 8} ${y}|L${x + 8} ${y} A8 8 0 0 0 ${x - 8} ${y}`));
  }
  await panel.screenshot({ path: 'test-results/routes-jump.png' });
});
