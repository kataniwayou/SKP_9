import type { Locator, Page } from '@playwright/test';
import { centreOf, documentPanel, expect, flowToPage, node, openWorkflow, pickWire, test, wirePoints as pointsOf } from './studio';
import { createGuidesThrowaway, removeThrowaway, type GuidesThrowaway } from './throwaway';

// The wire guides and equal spacing (the user's, 2026-10-23), with the real mouse, on a canvas made for them (`e2e-wg-…`):
// a fans out to b, c, d on one trunk (one net) and to e (Failed, another net, on the trunk's line); b and c fan in to f,
// one of them straight, the other with an upright and two level runs; d -> g; one cache. Each case below was found by
// sweeping drags over this canvas against an independent oracle: a true positive, or a false positive or negative fixed.
// Nothing is saved but where a drop is the point.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: GuidesThrowaway;
test.beforeAll(async ({ request }) => { t = await createGuidesThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
const W = (a: keyof GuidesThrowaway, b: keyof GuidesThrowaway) => `${t[a] as string}->${t[b] as string}`;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** The two wires into f, whichever of b and c the layout put above: the straight one and the one with an upright. */
async function intoF(panel: Locator): Promise<{ straight: string; bent: string }> {
  const ids = [W('b', 'f'), W('c', 'f')];
  const bent = (await pointsOf(panel, ids[0]!)).length > 2 ? ids[0]! : ids[1]!;
  return { straight: ids.find((x) => x !== bent)!, bent };
}

/** What the overlay shows: guide lines (axis and place), gap marks ([from, to] along their axis), red stretches. */
async function overlay(panel: Locator) {
  return panel.evaluate((root) => {
    const n = (e: Element, a: string) => Number(e.getAttribute(a));
    return {
      guides: [...root.querySelectorAll('line.design-guide.run')].map((l) => (n(l, 'x1') === n(l, 'x2') ? `x=${n(l, 'x1')}` : `y=${n(l, 'y1')}`)).sort(),
      gaps: [...root.querySelectorAll('g.design-gap')].map((g) => {
        const l = g.querySelector('line')!;
        return n(l, 'x1') === n(l, 'x2') ? [n(l, 'y1'), n(l, 'y2')] : [n(l, 'x1'), n(l, 'x2')];
      }).sort((p, q) => p[0]! - q[0]! || p[1]! - q[1]!),
      red: root.querySelectorAll('path.design-short').length,
    };
  });
}

/** Presses `from` (flow) and moves the real mouse through `path` (flow), a grid step out first so it is a drag; held. */
async function hold(page: Page, panel: Locator, from: [number, number], path: [number, number][]): Promise<void> {
  const p = await flowToPage(panel, from);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (const q of path) {
    const to = await flowToPage(panel, q);
    await page.mouse.move(to.x, to.y, { steps: 4 });
  }
  await frames(page);
}

/** The flow point of a picked wire's handle: a run dot (`k`) or an end dot. */
async function handle(panel: Locator, wire: string, which: { k: number } | { side: 'tail' | 'head' }): Promise<[number, number]> {
  const sel = 'k' in which ? `.design-handle.seg[data-k="${which.k}"]` : `.design-handle.end[data-end="${which.side}"]`;
  const h = panel.locator(`.design-wire[data-wire="${wire}"] ${sel}`);
  return [Number(await h.getAttribute('cx')), Number(await h.getAttribute('cy'))];
}

const cancel = async (page: Page) => { await page.keyboard.press('Escape'); await page.mouse.up(); };

test('wire to wire, upright: the trunk of a -> d held near the middle between a and its fan-out siblings snaps there, with both gaps marked', async ({ page }) => {
  const panel = await open(page);
  const ad = W('a', 'd');
  await pickWire(page, panel, ad);
  // a's right side at 576, a -> b and a -> c's trunk at 640: the middle is 608
  await hold(page, panel, await handle(panel, ad, { k: 1 }), [[620, 850], [600, 850]]);
  const o = await overlay(panel);
  expect(o.guides).toEqual([]);
  expect(o.gaps).toEqual([[576, 608], [608, 640]]);
  expect(o.red).toBe(0);
  await cancel(page);
});

test('wire to wire, upright: on the shared trunk line the siblings are one neighbour, so the gap to b is found and marked once', async ({ page }) => {
  const panel = await open(page);
  const ad = W('a', 'd');
  await pickWire(page, panel, ad);
  // the trunk at 640 (a -> b and a -> c lie on it too), b's column at 704: the middle is 672
  await hold(page, panel, await handle(panel, ad, { k: 1 }), [[700, 850], [664, 850]]);
  const o = await overlay(panel);
  expect(o.gaps).toEqual([[640, 672], [672, 704]]);
  await cancel(page);
});

test('no false spacing: the upright into f held beside the b and c column (both right sides at 928) marks no gaps', async ({ page }) => {
  const panel = await open(page);
  const { bent } = await intoF(panel);
  await pickWire(page, panel, bent);
  // 24 px right of the column: b to the run and c to the run are the same gap seen twice, not an equal spacing
  await hold(page, panel, await handle(panel, bent, { k: 1 }), [[970, 576], [952, 576]]);
  expect((await overlay(panel)).gaps).toEqual([]);
  await cancel(page);
});

test('the upright into f held near the middle of its row snaps there, every 64 px gap of the row marked', async ({ page }) => {
  const panel = await open(page);
  const { bent } = await intoF(panel);
  await pickWire(page, panel, bent);
  await hold(page, panel, await handle(panel, bent, { k: 1 }), [[960, 576], [981, 576]]);
  const o = await overlay(panel);
  // the trunk to the b/c column, the column to the run, the run to f
  expect(o.gaps).toEqual(expect.arrayContaining([[640, 704], [928, 992], [992, 1056]]));
  expect(o.guides).toEqual([]);
  await cancel(page);
});

test('an end: one axis that fails (it would land on a wire) keeps the other: held at (1000, 380) the head keeps its x guide on the upright into f', async ({ page }) => {
  const panel = await open(page);
  const ae = W('a', 'e');
  await pickWire(page, panel, ae);
  // y 380 would snap to b's or c's middle (400), within reach of the straight wire into f (416): a join, refused as a snap;
  // x 1000 snaps to the upright into f (992) alone
  await hold(page, panel, await handle(panel, ae, { side: 'head' }), [[1000, 220], [1000, 380]]);
  expect((await overlay(panel)).guides).toEqual(['x=992']);
  await cancel(page);
});

test('an end released on two guides lands on both', async ({ page }) => {
  const panel = await open(page);
  const ae = W('a', 'e');
  await pickWire(page, panel, ae);
  // a's bottom side (256) and the upright into f (992)
  await hold(page, panel, await handle(panel, ae, { side: 'head' }), [[760, 260], [977, 262]]);
  expect((await overlay(panel)).guides).toEqual(['x=992', 'y=256']);
  await page.mouse.up();
  await expect.poll(async () => (await pointsOf(panel, ae)).at(-1)).toEqual([992, 256]);
});

test('a wire moved whole lines up on both axes; with an end over a wire it joins there, and no guide shows', async ({ page }) => {
  const panel = await open(page);
  const { straight } = await intoF(panel);
  const [[x0, y0]] = await pointsOf(panel, straight);
  // pressed on its body and moved down to 560, 20 left: its left end lines up with b's and c's right sides (928), its
  // line with the cache's bottom (576)
  await hold(page, panel, [x0! + 32, y0!], [[x0! + 32, 560], [x0! + 12, 560]]);
  expect((await overlay(panel)).guides).toEqual(['x=928', 'y=576']);
  // 84 left: its right end on the upright into f (992), a join there, and no guide
  await page.mouse.move(...(Object.values(await flowToPage(panel, [x0! + 32 - 84, 560])) as [number, number]), { steps: 4 });
  await frames(page);
  expect(await panel.locator('.design-drop-label').allTextContents()).toContain('join here');
  expect((await overlay(panel)).guides).toEqual([]);
  await cancel(page);
});

// ---- the user's four rules (2026-10-23): spacing among three blocks or three parallel wires in a row or not, guides
// regardless of colour or the contact, and landings spaced evenly on a step's side. The layout of this canvas varies
// from run to run (which of b and c is above, where f lands), so every place below is read off the canvas.

/** A block's box on the canvas (flow px). */
const boxOf = (panel: Locator, id: string) => node(panel, id).evaluate((el) => {
  const e = el as HTMLElement;
  const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec(e.style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]), w: e.offsetWidth, h: e.offsetHeight };
});
const labels = (panel: Locator) => panel.locator('.design-drop-label').allTextContents();

test("a contact spaces evenly: a -> e's head on f's input side snaps a gap above the two landings there, marked; then the bent wire's head square slid to the middle of the others", async ({ page }) => {
  const panel = await open(page);
  const ae = W('a', 'e');
  const { straight, bent } = await intoF(panel);
  const F = await boxOf(panel, t.f);
  const sLand = (await pointsOf(panel, straight)).at(-1)![1]!, bLand = (await pointsOf(panel, bent)).at(-1)![1]!;
  const [l0, l1] = [sLand, bLand].sort((p, q) => p - q) as [number, number];
  const third = l0 - (l1 - l0);
  await pickWire(page, panel, ae);
  await hold(page, panel, await handle(panel, ae, { side: 'head' }), [[F.x - 56, F.y - 52], [F.x - 4, third + 3]]);
  expect((await overlay(panel)).gaps).toEqual([[third, l0], [l0, l1]]);
  expect(await labels(panel)).toEqual(['connect here']);
  await page.mouse.up();
  await expect.poll(async () => (await pointsOf(panel, ae)).at(-1)).toEqual([F.x, third]);
  // the bent wire's head square slid along f's side (its last run has no square, the user's 2026-10-26): the others land
  // at `third` and the straight wire's height, and their middle is evenly spaced
  const mid = (third + sLand) / 2;
  await pickWire(page, panel, bent);
  await hold(page, panel, await handle(panel, bent, { side: 'head' }), [[F.x - 4, bLand + 8], [F.x - 4, mid]]);
  expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining([[third, mid], [mid, sLand]].map((x) => x.sort((p, q) => p - q))));
  await cancel(page);
});

test("regardless of the contact: an end on a step side lines up with the step's centre and lands there", async ({ page }) => {
  const panel = await open(page);
  const ae = W('a', 'e');
  const B = await boxOf(panel, t.b);
  await pickWire(page, panel, ae);
  await hold(page, panel, await handle(panel, ae, { side: 'head' }), [[B.x - 14, B.y - 60], [B.x - 4, B.y + 82]]);
  expect((await overlay(panel)).guides).toContain(`y=${B.y + 80}`);
  expect(await labels(panel)).toEqual(['connect here']);
  const contact = await centreOf(panel.locator('.design-contact.ok'));
  expect(Math.abs(contact.y - (await flowToPage(panel, [B.x, B.y + 80])).y)).toBeLessThan(2);
  await cancel(page);
});

test('blocks in no shared row: an empty step held right of g and below it snaps 128 from it, as g is from the d column, both gaps marked', async ({ page }) => {
  const panel = await open(page);
  await page.getByRole('button', { name: 'Zoom out' }).first().click();
  await frames(page);
  const D = await boxOf(panel, t.d), G = await boxOf(panel, t.g);
  const want = G.x + G.w + (G.x - (D.x + D.w));
  const tile = await centreOf(page.getByText('empty step', { exact: false }).first());
  await page.mouse.move(tile.x, tile.y);
  await page.mouse.down();
  // below g's bottom: in no row with g or d, so only a chain of the three spaces it
  const cy = G.y + G.h + 40 + 80;
  for (const q of [[want + 112 + 40, cy], [want + 112 + 6, cy]] as [number, number][]) {
    const to = await flowToPage(panel, q);
    await page.mouse.move(to.x, to.y, { steps: 6 });
  }
  await frames(page);
  expect(Number(await panel.locator('rect.design-tool-landing').getAttribute('x'))).toBe(want);
  expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining([[D.x + D.w, G.x], [G.x + G.w, want]]));
  await cancel(page);
  await expect(node(panel, t.g)).toBeVisible();
});
