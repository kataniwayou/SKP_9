import type { Locator, Page } from '@playwright/test';
import { centreOf, documentPanel, dragEnd, edge, expect, flowToPage, openWorkflow, test, wirePoints, zoomOf, type Pt } from './studio';
import { createDrawingThrowaway, removeThrowaway, type DrawingThrowaway } from './throwaway';

// The user's circle rules (2026-10-26), with the real mouse on the drawing throwaway (`e2e-dg-…`, its routes stored):
// rule 1, a circle always shows the double arrow and resizes what meets it, a contact too; rule 2, anywhere else on the
// line is the four-way arrow and moves the wire whole; rule 3, a run too short on screen has no circle. Nothing is saved.
test.describe.configure({ mode: 'default', retries: 0 });
let t: DrawingThrowaway;
test.beforeAll(async ({ request }) => { t = await createDrawingThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const W = (a: string, b: string) => `${a}->${b}`;
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** Picks wire `id` by clicking flow point `at` on it, where no other wire crosses. */
async function pick(page: Page, panel: Locator, id: string, at: readonly [number, number]): Promise<void> {
  const p = await flowToPage(panel, at);
  await page.mouse.click(p.x, p.y);
  await expect(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end`).first()).toBeVisible();
}

/** The picked wire's circles: `k:cursor` a run's, `c<i>:cursor` a corner's, `tail:cursor` / `head:cursor` an end's. */
const circles = (panel: Locator, id: string) => panel.locator(`.design-wire[data-wire="${id}"] .design-handle`).evaluateAll((els) => els.map((e) =>
  `${e.getAttribute('data-k') ?? (e.getAttribute('data-c') !== null ? `c${e.getAttribute('data-c')}` : e.getAttribute('data-end'))}:${getComputedStyle(e).cursor}`));

const run = (panel: Locator, id: string, k: number) => panel.locator(`.design-wire[data-wire="${id}"] .design-handle.seg[data-k="${k}"]`);
const corner = (panel: Locator, id: string, c: number) => panel.locator(`.design-wire[data-wire="${id}"] .design-handle.corner[data-c="${c}"]`);

/** Presses `from` (page px), moves to flow point `to` and, held there, reads the canvas's gesture class; then releases. */
async function drag(page: Page, panel: Locator, from: Pt, to: readonly [number, number]): Promise<string> {
  const q = await flowToPage(panel, to);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + q.x) / 2, (from.y + q.y) / 2, { steps: 4 });
  await page.mouse.move(q.x, q.y, { steps: 4 });
  await frames(page);
  const cls = (await panel.locator('.studio-canvas').getAttribute('class')) ?? '';
  await page.mouse.up();
  await frames(page);
  return /gesture-(\w+)/.exec(cls)?.[1] ?? (cls.includes('gesture') ? 'body' : 'none');
}

/** What is under page point `p`: its class and its cursor. */
const under = (page: Page, p: Pt) => page.evaluate(([x, y]) => { const e = document.elementFromPoint(x!, y!)!; return `${e.getAttribute('class')} ${getComputedStyle(e).cursor}`; }, [p.x, p.y]);

const undo = async (page: Page, panel: Locator, id: string, was: unknown) => {
  await page.keyboard.press('Control+z');
  await expect.poll(() => wirePoints(panel, id)).toEqual(was);
};

test('case 1, a straight wire: circles on its two contacts only, each the double arrow; the line is the four-way arrow and moves it whole', async ({ page }) => {
  const panel = await open(page);
  const id = W(t.h1, t.h2);
  await pick(page, panel, id, [656, 320]);
  expect(await circles(panel, id)).toEqual(['tail:ns-resize', 'head:ns-resize']);
  const mid = await flowToPage(panel, [656, 320]);
  expect(await under(page, mid)).toBe('nx-hit grab move');
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  const to = await flowToPage(panel, [656, 600]);
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await expect(panel.locator('.studio-canvas')).toHaveClass(/\bgesture-move\b/);
  await expect(panel.locator('g.design-wire-copy')).not.toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('case 2, h2 -> v1 (out, down, in): a circle on each run, each corner and each contact; each does what its arrow says', async ({ page }) => {
  const panel = await open(page);
  const id = W(t.h2, t.v1);
  const was = await wirePoints(panel, id);
  expect(was).toEqual([[960, 384], [1024, 384], [1024, 704], [1600, 704]]);
  await pick(page, panel, id, [1300, 704]);
  expect(await circles(panel, id)).toEqual(['c1:nesw-resize', 'c2:nesw-resize', '0:ns-resize', '1:ew-resize', '2:ns-resize', 'tail:ns-resize', 'head:ns-resize']);

  // off its circles, on the upright: the four-way arrow
  expect(await under(page, await flowToPage(panel, [1024, 640]))).toBe('nx-hit grab move');

  // the upright's circle: sideways, both contacts stay (left: rightwards its tail run would lie on wf -> h3's at y 384,
  // a short circuit that snaps back)
  expect(await drag(page, panel, await centreOf(run(panel, id, 1)), [992, 544])).toBe('ew');
  let now = await wirePoints(panel, id);
  expect(now[0]).toEqual([960, 384]);
  expect(now[now.length - 1]).toEqual([1600, 704]);
  expect(now[1]![0]).toBeLessThan(1024);
  expect(now[1]![0]).toBe(now[2]![0]);
  await undo(page, panel, id, was);

  // the run at the tail: up and down, its contact sliding along h2's side with it (never anchored). Up, as 384 is as low
  // as a contact goes on h2's side, to 368: above 352 its upright would lie on h2 -> h4's at x 1024, a short circuit
  await pick(page, panel, id, [1300, 704]);
  expect(await drag(page, panel, await centreOf(run(panel, id, 0)), [992, 368])).toBe('ns');
  now = await wirePoints(panel, id);
  expect(now[0]![0]).toBe(960);
  expect(now[0]![1]).toBeLessThan(384);
  expect(now[1]).toEqual([1024, now[0]![1]]);
  expect(now[now.length - 1]).toEqual([1600, 704]);
  await undo(page, panel, id, was);

  // the run at the head: its contact slides along v1's side
  await pick(page, panel, id, [1300, 704]);
  expect(await drag(page, panel, await centreOf(run(panel, id, 2)), [1300, 608])).toBe('ns');
  now = await wirePoints(panel, id);
  expect(now[0]).toEqual([960, 384]);
  expect(now[now.length - 1]![0]).toBe(1600);
  expect(now[now.length - 1]![1]).toBeLessThan(704);
  expect(now[2]).toEqual([1024, now[now.length - 1]![1]]);
  await undo(page, panel, id, was);

  // the lower corner: diagonally, the upright and the run at the head at once, the head sliding with it
  await pick(page, panel, id, [1300, 704]);
  expect(await drag(page, panel, await centreOf(corner(panel, id, 2)), [992, 608])).toBe('nesw');
  now = await wirePoints(panel, id);
  expect(now[0]).toEqual([960, 384]);
  expect(now[1]![0]).toBeLessThan(1024);
  expect(now[now.length - 1]![1]).toBeLessThan(704);
  expect(now[2]).toEqual([now[1]![0], now[now.length - 1]![1]]);
  await undo(page, panel, id, was);
});

test('case 3, an inner run (h1 -> h4 under the row): its circle moves it alone, both contacts and the uprights stay', async ({ page }) => {
  const panel = await open(page);
  const id = W(t.h1, t.h4);
  const was = await wirePoints(panel, id);
  expect(was).toEqual([[576, 384], [672, 384], [672, 480], [1440, 480], [1440, 384], [1504, 384]]);
  await pick(page, panel, id, [1200, 480]);
  expect(await drag(page, panel, await centreOf(run(panel, id, 2)), [1200, 600])).toBe('ns');
  const now = await wirePoints(panel, id);
  expect(now.length).toBe(was.length);
  expect([now[0], now[1], now[4], now[5]]).toEqual([was[0], was[1], was[4], was[5]]);
  expect(now[2]![0]).toBe(672);
  expect(now[2]![1]).toBeGreaterThan(480);
  expect(now[3]).toEqual([1440, now[2]![1]]);
  await undo(page, panel, id, was);
});

test('a tail on the workflow circle cannot slide: its run\'s circle moves the run and a jog keeps the tail where it is (wf -> h2)', async ({ page }) => {
  const panel = await open(page);
  const id = W('wf', t.h2);
  const was = await wirePoints(panel, id);
  await pick(page, panel, id, [500, 160]);
  expect(await circles(panel, id)).toContain('0:ns-resize');
  expect(await drag(page, panel, await centreOf(run(panel, id, 0)), [256, 288])).toBe('ns');
  const now = await wirePoints(panel, id);
  expect(now[0]).toEqual(was[0]);
  expect(now.length).toBeGreaterThan(was.length);
  expect(now[now.length - 1]).toEqual(was[was.length - 1]);
  await undo(page, panel, id, was);
});

test('rule 3: a run too short on screen has no circle (h4 -> v3 leaves h4 by a 32 px run)', async ({ page }) => {
  const panel = await open(page);
  const id = W(t.h4, t.v3);
  await pick(page, panel, id, [1472, 900]);
  const z = await zoomOf(panel);
  const ks = (await circles(panel, id)).filter((c) => /^\d/.test(c)).map((c) => Number(c.split(':')[0]));
  // a circle only on a run at least two circles' width (20 px) long on screen
  expect(ks.includes(0)).toBe(32 * z >= 20);
  expect(ks).toContain(3);
});

test('the user\'s case: a wire joined on a level line, its upright dragged sideways, slides its junction along the line with it', async ({ page }) => {
  const panel = await open(page);
  const id = W(t.h3, t.v2);
  // h3 -> v2's head dropped on wf -> h3's level run (both Failed): a junction there
  expect(await dragEnd(page, panel, id, 'head', await flowToPage(panel, [1000, 512]))).toBe('join here');
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
  const was = await wirePoints(panel, id);
  const [jx, jy] = was[was.length - 1]!;
  expect(jy).toBe(512);
  // the upright nearest the junction: the last run square that moves sideways
  await pick(page, panel, id, [1184, 440]);
  const uprights = panel.locator(`.design-wire[data-wire="${id}"] .design-handle.seg.v`);
  const last = uprights.nth((await uprights.count()) - 1);
  const k = Number(await last.getAttribute('data-k'));
  const x0 = Number(await last.getAttribute('cx'));
  expect(await drag(page, panel, await centreOf(last), [x0 - 128, Number(await last.getAttribute('cy'))])).toBe('ew');
  const now = await wirePoints(panel, id);
  const [nx, ny] = now[now.length - 1]!;
  // the junction moved along the line as far as the upright did, still on it, still joined
  expect(ny).toBe(512);
  expect(nx).toBeLessThan(jx - 64);
  // as far as the upright did, within a grid step (the junction lies on the grid along its host)
  expect(Math.abs((now[k]![0] - x0) - (nx - jx))).toBeLessThanOrEqual(8);
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
  // and the other way: a second drag back right carries it back
  await pick(page, panel, id, [1184, 440]);
  const again = panel.locator(`.design-wire[data-wire="${id}"] .design-handle.seg[data-k="${k}"]`);
  const x1 = Number(await again.getAttribute('cx'));
  await drag(page, panel, await centreOf(again), [x1 + 64, Number(await again.getAttribute('cy'))]);
  const back = await wirePoints(panel, id);
  expect(back[back.length - 1]![1]).toBe(512);
  expect(back[back.length - 1]![0]).toBeGreaterThan(nx + 32);
});
