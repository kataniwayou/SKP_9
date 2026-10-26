import type { Locator, Page } from '@playwright/test';
import { centreOf, documentPanel, expect, flowToPage, node, openWorkflow, test, zoomOf, type Pt } from './studio';
import { createDrawingThrowaway, DRAWING, removeThrowaway, type DrawingThrowaway } from './throwaway';

// Every alignment guide and equal-spacing mark, for blocks and for wires, with the real mouse (the user's, 2026-10-25),
// on the drawing throwaway (`e2e-dg-…`): h1 h2 h3 h4 in a row, v1 v2 v3 v4 down the right, each set off sideways, every
// block feeding the next three. Blocks are all one size but the hub, so the hub is what tells one kind of edge from
// another. Each test asserts what Visio shows (the authority, plan 10), and the user's rulings: blocks keep equal gaps to
// wires (2026-10-25); only a run between two bends has a square (2026-10-26). Nothing is saved but where a drop is the
// point: each test starts from a fresh page, so the tests are independent and every one runs when another fails (a
// failure restarts the worker: a fresh throwaway for the rest).
test.describe.configure({ mode: 'default', retries: 0 });
let t: DrawingThrowaway;
test.beforeAll(async ({ request }) => { t = await createDrawingThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

type Box = { x: number; y: number; w: number; h: number };
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
const W = (a: string, b: string) => `${a}->${b}`;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** A block's box (flow px), from its transform. */
const boxOf = (panel: Locator, id: string): Promise<Box> => node(panel, id).evaluate((el) => {
  const e = el as HTMLElement;
  const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec(e.style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]), w: e.offsetWidth, h: e.offsetHeight };
});

/**
 * What the overlay shows: a block drag's guide lines and a wire drag's (`x=` a vertical line, `y=` a level one), every
 * equal-gap mark (`x:a-b` a gap along x from a to b, `y:a-b` along y), the drop labels and the ghost's path.
 */
async function overlay(panel: Locator) {
  return panel.evaluate((root) => {
    const n = (e: Element, a: string) => Number(e.getAttribute(a));
    const line = (l: Element) => (n(l, 'x1') === n(l, 'x2') ? `x=${n(l, 'x1')}` : `y=${n(l, 'y1')}`);
    return {
      lines: [...new Set([...root.querySelectorAll('line.design-guide:not(.run)')].map(line))].sort(),
      guides: [...new Set([...root.querySelectorAll('line.design-guide.run')].map(line))].sort(),
      gaps: [...new Set([...root.querySelectorAll('g.design-gap')].map((g) => {
        const l = g.querySelector('line')!;
        return n(l, 'y1') === n(l, 'y2') ? `x:${n(l, 'x1')}-${n(l, 'x2')}` : `y:${n(l, 'y1')}-${n(l, 'y2')}`;
      }))].sort(),
      labels: [...root.querySelectorAll('.design-drop-label text')].map((x) => x.textContent ?? ''),
      ghost: root.querySelector('path.design-ghost')?.getAttribute('d') ?? null,
    };
  });
}
const xs = (marks: string[]) => marks.filter((m) => m.startsWith('x'));
const ys = (marks: string[]) => marks.filter((m) => m.startsWith('y'));

/** Where a block is grabbed: a step by its caption, the hub by its centre. */
const grip = (panel: Locator, id: string): Promise<Pt> => (id === 'wf' ? centreOf(node(panel, id)) : centreOf(node(panel, id).locator('.nx-sn')));

/**
 * Presses block `id` and moves it by (dx, dy) flow px with the real mouse; held. `out`: first that far right (flow px),
 * for a move too short to start a drag on its own.
 */
async function holdBlock(page: Page, panel: Locator, id: string, dx: number, dy: number, out = 0): Promise<void> {
  const z = await zoomOf(panel);
  const from = await grip(panel, id);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + ((out || dx / 3) * z), from.y + (dy * z) / 3, { steps: 4 });
  await page.mouse.move(from.x + dx * z, from.y + dy * z, { steps: 8 });
  await frames(page);
}

/** Presses `from` (flow) and moves the real mouse through `path` (flow); held. */
async function hold(page: Page, panel: Locator, from: readonly [number, number], path: readonly (readonly [number, number])[]): Promise<void> {
  const p = await flowToPage(panel, from);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (const q of path) {
    const to = await flowToPage(panel, q);
    await page.mouse.move(to.x, to.y, { steps: 5 });
  }
  await frames(page);
}

const release = async (page: Page) => { await page.mouse.up(); await frames(page); };
const cancel = async (page: Page) => { await page.keyboard.press('Escape'); await page.mouse.up(); await frames(page); };

/** Picks a wire by clicking `at` (flow), a point on it no other wire crosses. */
async function pick(page: Page, panel: Locator, id: string, at: readonly [number, number]): Promise<void> {
  const p = await flowToPage(panel, at);
  await page.mouse.click(p.x, p.y);
  await expect(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end`).first()).toBeVisible();
}

/** A picked wire's run square (`k`) or end square, in flow px. */
async function handle(panel: Locator, id: string, which: { k: number } | { side: 'tail' | 'head' }): Promise<[number, number]> {
  const sel = 'k' in which ? `.design-handle.seg[data-k="${which.k}"]` : `.design-handle.end[data-end="${which.side}"]`;
  const h = panel.locator(`.design-wire[data-wire="${id}"] ${sel}`);
  return [Number(await h.getAttribute('cx')), Number(await h.getAttribute('cy'))];
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks: alignment. Like to like (Visio): a left edge with left edges, a centre with centres, a right edge with right
// edges; a top, a middle, a bottom, a processor middle each with its own kind. 12 screen px reach (about 22 flow px
// at this canvas's fitted zoom).

test.describe('blocks: alignment', () => {
  test('left, centre and right line up together with a block of the same width (v3 under v1)', async ({ page }) => {
    const panel = await open(page);
    // v3 at 1536, 6 short of v1's 1600
    await holdBlock(page, panel, t.v3, 1594 - DRAWING.v3.x, 0);
    expect((await overlay(panel)).lines).toEqual(expect.arrayContaining(['x=1600', 'x=1712', 'x=1824']));
    await release(page);
    expect(await boxOf(panel, t.v3)).toMatchObject({ x: 1600, y: DRAWING.v3.y });
  });

  test('centre with centre alone: the hub under h1, its centre 5 off h1\'s', async ({ page }) => {
    const panel = await open(page);
    const hub = await boxOf(panel, 'wf');
    // the hub's centre to 469 (h1's is 464), below the row where no edge of its kind is in reach
    await holdBlock(page, panel, 'wf', 373 - hub.x, 620 - hub.y);
    const o = await overlay(panel);
    expect(xs(o.lines)).toEqual(['x=464']);
    expect(ys(o.lines)).toEqual([]);
    await release(page);
    expect((await boxOf(panel, 'wf')).x).toBe(464 - hub.w / 2);
  });

  test('right edge with right edge alone: the hub\'s right edge 3 off h1\'s', async ({ page }) => {
    const panel = await open(page);
    const hub = await boxOf(panel, 'wf');
    await holdBlock(page, panel, 'wf', 573 - hub.w - hub.x, 620 - hub.y);
    expect(xs((await overlay(panel)).lines)).toEqual(['x=576']);
    await release(page);
    expect((await boxOf(panel, 'wf')).x).toBe(576 - hub.w);
  });

  // the hub's middle is its centre, dragged or standing still (2026-10-25: a dragged one had none)
  test('top with tops: the hub 3 above the row\'s tops; its middle meets the processor middles at the same move', async ({ page }) => {
    const panel = await open(page);
    const hub = await boxOf(panel, 'wf');
    await holdBlock(page, panel, 'wf', 0, 253 - hub.y);
    expect(ys((await overlay(panel)).lines)).toEqual(['y=256', 'y=352']);
    await release(page);
    expect((await boxOf(panel, 'wf')).y).toBe(256);
  });

  test('bottom with bottoms alone: the hub\'s bottom 3 below the row\'s', async ({ page }) => {
    const panel = await open(page);
    const hub = await boxOf(panel, 'wf');
    await holdBlock(page, panel, 'wf', 0, 419 - hub.h - hub.y);
    expect(ys((await overlay(panel)).lines)).toEqual(['y=416']);
    await release(page);
    expect((await boxOf(panel, 'wf')).y).toBe(416 - hub.h);
  });

  test('middle with middle alone: the hub\'s centre 3 below v1\'s', async ({ page }) => {
    const panel = await open(page);
    const hub = await boxOf(panel, 'wf');
    await holdBlock(page, panel, 'wf', 0, 659 - hub.h / 2 - hub.y);
    expect(ys((await overlay(panel)).lines)).toEqual(['y=656']);
    await release(page);
    expect((await boxOf(panel, 'wf')).y).toBe(656 - hub.h / 2);
  });

  test('all four heights of a step at once: h1 level with v1 (top, middle, processor middle, bottom)', async ({ page }) => {
    const panel = await open(page);
    await holdBlock(page, panel, t.h1, 0, 570 - DRAWING.h1.y);
    expect((await overlay(panel)).lines).toEqual(expect.arrayContaining(['y=576', 'y=656', 'y=672', 'y=736']));
    await release(page);
    expect((await boxOf(panel, t.h1)).y).toBe(576);
  });

  test('both axes at once: h4 over v1\'s column and level with the row', async ({ page }) => {
    const panel = await open(page);
    await holdBlock(page, panel, t.h4, 1594 - DRAWING.h4.x, 6);
    expect((await overlay(panel)).lines).toEqual(expect.arrayContaining(['x=1600', 'y=256']));
    await release(page);
    expect(await boxOf(panel, t.h4)).toMatchObject({ x: 1600, y: 256 });
  });

  test('like to like only: the hub\'s left edge 6 off h1\'s right edge does not snap to it', async ({ page }) => {
    const panel = await open(page);
    const hub = await boxOf(panel, 'wf');
    await holdBlock(page, panel, 'wf', 570 - hub.x, 620 - hub.y);
    expect(xs((await overlay(panel)).lines)).toEqual([]);
    await release(page);
    expect((await boxOf(panel, 'wf')).x).toBe(568);
  });

  test('out of reach: v3 30 short of v1\'s left edge stays where it is put, on the grid', async ({ page }) => {
    const panel = await open(page);
    await holdBlock(page, panel, t.v3, 1570 - DRAWING.v3.x, 0);
    expect((await overlay(panel)).lines).not.toContain('x=1600');
    await release(page);
    expect((await boxOf(panel, t.v3)).x).toBe(1568);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Blocks: spacing. Equal gaps in a row (the gap to a neighbour equal to one between two neighbours), the middle
// between two, and along a chain that needs no shared column (the column here is staggered).

test.describe('blocks: spacing', () => {
  test('row end: h4 held 10 past the row\'s gap snaps back, every equal gap of the row marked', async ({ page }) => {
    const panel = await open(page);
    await holdBlock(page, panel, t.h4, 10, 0);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['x:576-736', 'x:960-1120', 'x:1344-1504']));
    await release(page);
    expect((await boxOf(panel, t.h4)).x).toBe(DRAWING.h4.x);
  });

  // 10 off it would go to 752 instead, the middle of the uprights at 672 and 1056: nearer, and wires are spaced to too
  test('row middle: h2 held 4 off the middle of h1 and h3 snaps back, both its gaps marked', async ({ page }) => {
    const panel = await open(page);
    await holdBlock(page, panel, t.h2, 4, 0, 30);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['x:576-736', 'x:960-1120']));
    await release(page);
    expect((await boxOf(panel, t.h2)).x).toBe(DRAWING.h2.x);
  });

  test('row start: the hub takes the row\'s gap to h1 (160)', async ({ page }) => {
    const panel = await open(page);
    const hub = await boxOf(panel, 'wf');
    // its right edge 4 short of 192, where the gap to h1 is the row's
    await holdBlock(page, panel, 'wf', 196 - hub.w - hub.x, 0);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['x:192-352', 'x:576-736']));
    await release(page);
    expect((await boxOf(panel, 'wf')).x).toBe(192 - hub.w);
  });

  test('chain start: h1 held 10 left snaps back, its gap to h2 equal to h2\'s to h3', async ({ page }) => {
    const panel = await open(page);
    await holdBlock(page, panel, t.h1, -10, 0);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['x:576-736', 'x:960-1120']));
    await release(page);
    expect((await boxOf(panel, t.h1)).x).toBe(DRAWING.h1.x);
  });

  test('staggered column: v2 held 10 low snaps back between v1 and v3, both gaps marked', async ({ page }) => {
    const panel = await open(page);
    await holdBlock(page, panel, t.v2, 0, 10);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['y:736-896', 'y:1056-1216']));
    await release(page);
    expect((await boxOf(panel, t.v2)).y).toBe(DRAWING.v2.y);
  });

  test('column end: v4 held 10 low keeps the column\'s gap above it', async ({ page }) => {
    const panel = await open(page);
    await holdBlock(page, panel, t.v4, 0, 10);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['y:1376-1536', 'y:1056-1216']));
    await release(page);
    expect((await boxOf(panel, t.v4)).y).toBe(DRAWING.v4.y);
  });

  test('no false marks: h4 held 40 off the row\'s gap marks no gap along the row', async ({ page }) => {
    const panel = await open(page);
    await holdBlock(page, panel, t.h4, 40, 0);
    expect(xs((await overlay(panel)).gaps)).toEqual([]);
    await cancel(page);
  });

  test('h3 keeps equal gaps to the uprights beside it (1024 on its left, 1440 on its right, 96 each)', async ({ page }) => {
    const panel = await open(page);
    await holdBlock(page, panel, t.h3, 10, 0);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['x:1024-1120', 'x:1344-1440']));
    await cancel(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Wires: alignment. A dragged run lines up with block edges and centres and other wires' parallel runs; an end on both
// axes, and along a step side with the block lines; a wire moved whole with its runs and ends.

test.describe('wires: alignment', () => {
  test('a vertical run lines up with a block\'s right edge (h3\'s, far above it)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.v1, t.v4);
    await pick(page, panel, id, [1440, 1150]);
    await hold(page, panel, await handle(panel, id, { k: 3 }), [[1400, 1200], [1350, 1200]]);
    const o = await overlay(panel);
    expect(o.guides).toEqual(['x=1344']);
    expect(o.ghost).toContain('1344 ');
    await cancel(page);
  });

  test('a vertical run lines up with a block\'s centre (h3\'s)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.v1, t.v4);
    await pick(page, panel, id, [1440, 1150]);
    await hold(page, panel, await handle(panel, id, { k: 3 }), [[1300, 1200], [1238, 1200]]);
    expect((await overlay(panel)).guides).toEqual(['x=1232']);
    await cancel(page);
  });

  test('a level run lines up with another wire\'s level run beside it, not alongside (h4 -> v3 at 448)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h1, t.h4);
    await pick(page, panel, id, [1000, 480]);
    await hold(page, panel, await handle(panel, id, { k: 2 }), [[1056, 470], [1056, 452]]);
    expect((await overlay(panel)).guides).toEqual(['y=448']);
    await cancel(page);
  });

  test('a level run lines up with a block\'s top (v1\'s)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h1, t.h4);
    await pick(page, panel, id, [1000, 480]);
    await hold(page, panel, await handle(panel, id, { k: 2 }), [[1056, 540], [1056, 570]]);
    expect((await overlay(panel)).guides).toEqual(['y=576']);
    await cancel(page);
  });

  test('an end in open canvas lines up on both axes (h2\'s left edge, v1\'s top)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h1, t.h2);
    await pick(page, panel, id, [656, 320]);
    await hold(page, panel, await handle(panel, id, { side: 'head' }), [[736, 450], [742, 580]]);
    expect((await overlay(panel)).guides).toEqual(expect.arrayContaining(['x=736', 'y=576']));
    await page.mouse.up();
    await frames(page);
  });

  test('an end slid along a step side lines up with that block\'s centre (h2\'s, at 336)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h1, t.h2);
    await pick(page, panel, id, [656, 320]);
    await hold(page, panel, await handle(panel, id, { side: 'head' }), [[738, 326], [738, 334]]);
    expect((await overlay(panel)).guides).toEqual(['y=336']);
    await cancel(page);
  });

  test('a wire moved whole into open canvas lines up (its line with v1\'s top)', async ({ page }) => {
    const panel = await open(page);
    // h1 -> h2, pressed on its body and moved down into open canvas, 6 short of v1's top
    await hold(page, panel, [656, 320], [[656, 450], [656, 570]]);
    expect((await overlay(panel)).guides).toContain('y=576');
    await cancel(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Wires: spacing. A run in the middle of its neighbours (blocks or parallel runs), along a chain of parallel runs, a
// landing among a side's other landings (an end square on either side), an end's last leg, and a wire moved whole.

test.describe('wires: spacing', () => {
  test('a vertical run held off the middle of its neighbours snaps back, both gaps marked (h3 -> v1 at 1408)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h3, t.v1);
    await pick(page, panel, id, [1408, 560]);
    await hold(page, panel, await handle(panel, id, { k: 1 }), [[1430, 500], [1418, 500]]);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['x:1376-1408', 'x:1408-1440']));
    await cancel(page);
  });

  test('a level run held between a block and a run snaps to their middle (h4 -> v1 at 512, between 448 and v1\'s top)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h4, t.v1);
    await pick(page, panel, id, [1650, 512]);
    await hold(page, panel, await handle(panel, id, { k: 2 }), [[1664, 530], [1664, 522]]);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['y:448-512', 'y:512-576']));
    await cancel(page);
  });

  test('a chain of parallel uprights keeps its pitch (v1 -> v4 at 1440, among 1408 and 1472)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.v1, t.v4);
    await pick(page, panel, id, [1440, 1150]);
    await hold(page, panel, await handle(panel, id, { k: 3 }), [[1460, 1200], [1450, 1200]]);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['x:1408-1440', 'x:1440-1472']));
    await cancel(page);
  });

  test('an end square slid along a step\'s left side is spaced among its landings (h1 -> h4 on h4)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h1, t.h4);
    await pick(page, panel, id, [1000, 480]);
    await hold(page, panel, await handle(panel, id, { side: 'head' }), [[1508, 404], [1508, 394]]);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['y:320-352', 'y:352-384']));
    await cancel(page);
  });

  test('an end square held between two landings goes to their middle, both gaps marked (h1 -> h4 at 336 on h4)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h1, t.h4);
    await pick(page, panel, id, [1000, 480]);
    await hold(page, panel, await handle(panel, id, { side: 'head' }), [[1508, 360], [1508, 339]]);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['y:320-336', 'y:336-352']));
    await cancel(page);
  });

  test('an end square slid along a step\'s right side is spaced among its tails (h2 -> v1 on h2)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h2, t.v1);
    await pick(page, panel, id, [1024, 600]);
    await hold(page, panel, await handle(panel, id, { side: 'tail' }), [[956, 404], [956, 394]]);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['y:320-352', 'y:352-384']));
    await cancel(page);
  });

  test('an end\'s last leg held midway between two uprights marks both gaps, though an alignment ties there', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h1, t.h2);
    await pick(page, panel, id, [656, 320]);
    // down, right, down: the last leg upright at 848, h2's centre and the middle of 672 (h1 -> h4) and 1024 (h2 -> v1)
    await hold(page, panel, await handle(panel, id, { side: 'head' }), [[736, 450], [800, 452], [848, 452], [848, 600]]);
    const o = await overlay(panel);
    expect(o.ghost).toContain('848 576');
    expect(o.gaps).toEqual(expect.arrayContaining(['x:672-848', 'x:848-1024']));
    await cancel(page);
  });

  test('a wire moved whole along its contacts stays spaced among the landings of both sides (h3 -> h4)', async ({ page }) => {
    const panel = await open(page);
    await hold(page, panel, [1420, 320], [[1420, 340], [1420, 330]]);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['y:320-352', 'y:352-384']));
    await cancel(page);
  });

  test('a wire moved whole sideways keeps its upright in the middle of its neighbours (h3 -> v1)', async ({ page }) => {
    const panel = await open(page);
    await hold(page, panel, [1408, 500], [[1430, 500], [1418, 500]]);
    expect((await overlay(panel)).gaps).toEqual(expect.arrayContaining(['x:1376-1408', 'x:1408-1440']));
    await cancel(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Wires: which runs drag (the user's, 2026-10-26). A run square, with its double arrow, only on a run between two
// bends; a run at an end, whose end is fixed there, has none: pressed, the wire moves whole with the four-way arrow.

test.describe('wires: run squares', () => {
  test('a square on each run between two bends, none on a run at an end (h1 -> h3: down, across, up between its ends)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h1, t.h3);
    await pick(page, panel, id, [672, 300]);
    const squares = panel.locator(`.design-wire[data-wire="${id}"] .design-handle.seg`);
    expect(await squares.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-k')}:${getComputedStyle(e).cursor}`))).toEqual(['1:ew-resize', '2:ns-resize', '3:ew-resize']);
  });

  test('a run at an end has no square: its line shows the four-way arrow and a press there moves the wire whole (h3 -> v1)', async ({ page }) => {
    const panel = await open(page);
    const id = W(t.h3, t.v1);
    await pick(page, panel, id, [1408, 560]);
    expect(await panel.locator(`.design-wire[data-wire="${id}"] .design-handle.seg`).evaluateAll((els) => els.map((e) => e.getAttribute('data-k')))).toEqual(['1']);
    // its first run, from h3's right side at 352 to the upright at 1408
    const on = await flowToPage(panel, [1376, 352]);
    expect(await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x!, y!)!; return `${e.getAttribute('class')} ${getComputedStyle(e).cursor}`; }, [on.x, on.y])).toBe('nx-hit grab move');
    await hold(page, panel, [1376, 352], [[1376, 380], [1376, 400]]);
    const canvas = (await panel.locator('.studio-canvas').getAttribute('class')) ?? '';
    expect(canvas).toContain('gesture');
    expect(canvas).not.toMatch(/gesture-(ns|ew)/);
    // Visio's faded copy of the whole wire where the release puts it
    expect(await panel.locator('g.design-wire-copy').count()).toBeGreaterThan(0);
    await cancel(page);
  });
});
