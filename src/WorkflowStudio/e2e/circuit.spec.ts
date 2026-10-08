import type { Locator, Page } from '@playwright/test';
import {
  box, centreOf, documentPanel, dragEnd, edge, emptySpot, endSquare, expect, inspector, newWire, node, openWorkflow,
  pickWire, pointOnWire, tab, test, type Pt,
} from './studio';
import { createCircuitThrowaway, removeThrowaway, type CircuitThrowaway } from './throwaway';

// Plan 9: the ground rules of wires as a circuit, one test each, with the real mouse and keyboard. The workflow is a
// throwaway (e2e/throwaway.ts, `e2e-9-…`): steps a, b, c (Completed) and d (Failed), wired wf -> a, a -> b, a -> d,
// b -> c, and one cache, made and deleted through BaseApi's CRUD by the test runner. The browser only reads (studio.ts's
// guard): nothing here is saved, and every test starts from an empty session.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const TEAL = '#2DD4BF', RED = '#FF7A66', GREY = '#8A97A8';
const drawn = (panel: Locator, id: string) => edge(panel, id).locator('path.w').first();
const colourOf = (panel: Locator, id: string) => drawn(panel, id).getAttribute('stroke');
const dashOf = (panel: Locator, id: string) => drawn(panel, id).evaluate((el) => getComputedStyle(el).strokeDasharray);
const cursorAt = (page: Page, q: Pt) => page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, q);

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** A wire's points in flow coordinates, read from its drawn path. */
async function pointsOf(panel: Locator, id: string): Promise<[number, number][]> {
  const d = (await drawn(panel, id).getAttribute('d')) ?? '';
  return [...d.matchAll(/[ML]([-\d.e]+)[ ,]([-\d.e]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** A block's top-left corner and size in flow coordinates (React Flow's transform on the node, and its size). */
async function flowBox(panel: Locator, id: string): Promise<{ x: number; y: number; w: number; h: number }> {
  return node(panel, id).evaluate((el) => {
    const e = el as HTMLElement;
    const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec(e.style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), w: e.offsetWidth, h: e.offsetHeight };
  });
}

/** A page point inside a step: in its input half (near its left side) or its output half, `f` of the way down. */
async function onSide(panel: Locator, id: string, side: 'in' | 'out', f = 0.5): Promise<Pt> {
  const b = await box(node(panel, id));
  return { x: side === 'in' ? b.x + b.width * 0.15 : b.x + b.width * 0.85, y: b.y + b.height * f };
}

/** A page point inside the hub's disc at `deg` round its centre (0 right, 90 down). */
async function onHub(panel: Locator, deg: number): Promise<Pt> {
  const b = await box(node(panel, 'wf'));
  const r = (deg * Math.PI) / 180, R = b.width / 2;
  return { x: b.x + R + 0.8 * R * Math.cos(r), y: b.y + R + 0.8 * R * Math.sin(r) };
}

/** The hub's ring point at `deg`, in flow coordinates. */
async function ringAt(panel: Locator, deg: number): Promise<[number, number]> {
  const hub = await flowBox(panel, 'wf');
  const r = (deg * Math.PI) / 180, R = hub.w / 2;
  return [hub.x + R + R * Math.cos(r), hub.y + R + R * Math.sin(r)];
}

const near = (p: readonly number[] | undefined, q: readonly number[]) => {
  expect(p, 'the point exists').toBeDefined();
  expect(Math.hypot(p![0]! - q[0]!, p![1]! - q[1]!)).toBeLessThan(1);
};

/** Focuses the canvas (a click on its empty pane) so the keyboard's Undo and Redo reach it. */
async function focusCanvas(page: Page, panel: Locator): Promise<void> {
  const p = await emptySpot(panel);
  await page.mouse.click(p.x, p.y);
}

test('rule 1: tails dropped at the hub\'s top, left and bottom start there, several at once', async ({ page }) => {
  const panel = await open(page);
  const moves: [string, number][] = [[`wf->${t.a}`, 270], [`${t.b}->${t.c}`, 180], [`${t.a}->${t.d}`, 90]];
  for (const [id, deg] of moves) expect(await dragEnd(page, panel, id, 'tail', await onHub(panel, deg))).toBe('connect here');
  for (const [id, deg] of moves) near((await pointsOf(panel, id))[0], await ringAt(panel, deg));
  // all three at once, each at its own ring point, each a ring at its tail
  for (const [id] of moves) await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(1);
});

test('rule 2: a step takes ends on its left and right sides only, anywhere short of the corners: a head dropped high on b lands on its left side at 16, a tail low on b leaves its right side at 144', async ({ page }) => {
  const panel = await open(page);
  const b = await flowBox(panel, t.b);
  expect(await dragEnd(page, panel, `${t.a}->${t.b}`, 'head', await onSide(panel, t.b, 'in', 0.05))).toBe('connect here');
  expect((await pointsOf(panel, `${t.a}->${t.b}`)).at(-1)).toEqual([b.x, b.y + 16]);
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'tail', await onSide(panel, t.b, 'out', 0.95))).toBe('connect here');
  expect((await pointsOf(panel, `${t.b}->${t.c}`))[0]).toEqual([b.x + b.w, b.y + 144]);
  // neither the top nor the bottom of a step takes an end: dropped there it lands on a side
  for (const [id, side] of [[`${t.a}->${t.b}`, 'head'], [`${t.b}->${t.c}`, 'tail']] as const) {
    const bb = await box(node(panel, t.b));
    expect(await dragEnd(page, panel, id, side, { x: bb.x + bb.width * (side === 'head' ? 0.3 : 0.7), y: bb.y + 2 })).toBe('connect here');
    const p = side === 'head' ? (await pointsOf(panel, id)).at(-1)! : (await pointsOf(panel, id))[0]!;
    expect(p[0]).toBe(side === 'head' ? b.x : b.x + b.w);
    expect(p[1]).toBe(b.y + 16);
  }
});

test('rule 3: a wire is drawn with a ring at its tail and an arrow head at its head', async ({ page }) => {
  const panel = await open(page);
  for (const id of [`wf->${t.a}`, `${t.a}->${t.b}`, `${t.a}->${t.d}`, `${t.b}->${t.c}`]) {
    await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(1);
    await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(1);
    await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(0);
  }
  await expect(panel.locator('circle.nx-open')).toHaveCount(0);
});

test('rule 4: a head and a tail each join another wire at a chosen point, a filled circle and no arrow head there; itself and both ends on one wire are refused', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`, ad = `${t.a}->${t.d}`;
  // its head on wf -> a: b's current goes on into a (a loop through steps is allowed)
  expect(await dragEnd(page, panel, bc, 'head', await pointOnWire(panel, `wf->${t.a}`, 0.5, 12))).toBe('join here');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
  await expect(edge(panel, bc).locator('path.nx-head')).toHaveCount(0);
  await expect(edge(panel, bc).locator('circle.nx-src')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  // its tail on a -> b at the point chosen: it takes a's current there
  const at = await pointOnWire(panel, ab, 0.5, 12);
  expect(await dragEnd(page, panel, bc, 'tail', at)).toBe('join here');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
  await expect(edge(panel, bc).locator('circle.nx-src')).toHaveCount(0);
  await expect(edge(panel, bc).locator('path.nx-head')).toHaveCount(1);
  const dot = await centreOf(edge(panel, bc).locator('circle.nx-joint'));
  expect(Math.hypot(dot.x - at.x, dot.y - at.y)).toBeLessThan(10);
  // both ends on a -> b: refused, nothing changes
  const before = await pointsOf(panel, bc);
  expect(await dragEnd(page, panel, bc, 'head', await pointOnWire(panel, ab, 0.85, 12))).toBe('same wire');
  await expect(edge(panel, bc).locator('path.nx-head')).toHaveCount(1);
  expect(await pointsOf(panel, bc)).toEqual(before);
  // on itself: a -> d bent by a run drag first, then its head dropped on a run of its own other than the one at its head
  await pickWire(page, panel, ad);
  const run = panel.locator(`.design-wire[data-wire="${ad}"] .design-handle.seg`).first();
  const r = await centreOf(run);
  const across = /\bh\b/.test((await run.getAttribute('class')) ?? '');
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(across ? r.x : r.x + 48, across ? r.y + 48 : r.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await pointsOf(panel, ad)).length).toBeGreaterThanOrEqual(4);
  const own = await pointsOf(panel, ad);
  expect(await dragEnd(page, panel, ad, 'head', await pointOnWire(panel, ad, 0.2, 12))).toBe('same wire');
  expect(await pointsOf(panel, ad)).toEqual(own);
});

test('rule 5: a head on a step\'s right side and a tail on its left side are refused ("wrong side"); a head on its own tail\'s step is "same step"; each slides along its own side', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  const before = await pointsOf(panel, ab);
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.b, 'out'))).toBe('wrong side');
  expect(await pointsOf(panel, ab)).toEqual(before);
  const bcBefore = await pointsOf(panel, bc);
  expect(await dragEnd(page, panel, bc, 'tail', await onSide(panel, t.b, 'in'))).toBe('wrong side');
  expect(await pointsOf(panel, bc)).toEqual(bcBefore);
  // a -> b's head on a's own input: both ends on one step
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.a, 'in'))).toBe('same step');
  expect(await pointsOf(panel, ab)).toEqual(before);
  // slid along their sides: a head (step-attached) on b's input, a tail on b's output
  const b = await flowBox(panel, t.b);
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.b, 'in', 0.75))).toBe('connect here');
  expect((await pointsOf(panel, ab)).at(-1)).toEqual([b.x, b.y + 120]);
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.b, 'in', 0.15))).toBe('connect here');
  expect((await pointsOf(panel, ab)).at(-1)).toEqual([b.x, b.y + 24]);
  expect(await dragEnd(page, panel, bc, 'tail', await onSide(panel, t.b, 'out', 0.45))).toBe('connect here');
  expect((await pointsOf(panel, bc))[0]).toEqual([b.x + b.w, b.y + 72]);
});

test('rule 6: a head over the hub is refused: "only a tail on the workflow"', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  const before = await pointsOf(panel, ab);
  expect(await dragEnd(page, panel, ab, 'head', await onHub(panel, 0))).toBe('only a tail on the workflow');
  await expect(node(panel, 'wf')).not.toHaveClass(/drop-/);
  expect(await pointsOf(panel, ab)).toEqual(before);
});

test('rule 7: a wire with only its tail on a step (or on the hub) is grey and dashed', async ({ page }) => {
  const panel = await open(page);
  const spot = await emptySpot(panel);
  const id = await newWire(page, panel, t.a, spot);
  expect(await colourOf(panel, id)).toBe(GREY);
  expect(await dashOf(panel, id)).not.toBe('none');
  await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(1);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(1);
  const hubWire = await newWire(page, panel, 'wf', await emptySpot(panel, [spot]));
  expect(await colourOf(panel, hubWire)).toBe(GREY);
  expect(await dashOf(panel, hubWire)).not.toBe('none');
});

test('rule 8: a tail joined to a teal wire turns its wire teal', async ({ page }) => {
  const panel = await open(page);
  const id = await newWire(page, panel, t.a, await emptySpot(panel));
  expect(await colourOf(panel, id)).toBe(GREY);
  expect(await dragEnd(page, panel, id, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  expect(await colourOf(panel, id)).toBe(TEAL);
  expect(await dashOf(panel, id)).not.toBe('none'); // its head is still open
});

test('rule 9: a head on a step takes the step\'s colour', async ({ page }) => {
  const panel = await open(page);
  const id = await newWire(page, panel, t.a, await emptySpot(panel));
  expect(await dragEnd(page, panel, id, 'head', await onSide(panel, t.d, 'in'))).toBe('connect here');
  expect(await colourOf(panel, id)).toBe(RED);
  expect(await dashOf(panel, id)).toBe('none');
  expect(await dragEnd(page, panel, id, 'head', await onSide(panel, t.c, 'in'))).toBe('connect here');
  expect(await colourOf(panel, id)).toBe(TEAL);
});

test('rule 10: a head joined to a wire takes its colour (fan-in)', async ({ page }) => {
  const panel = await open(page);
  const id = await newWire(page, panel, t.d, await emptySpot(panel));
  expect(await colourOf(panel, id)).toBe(GREY);
  expect(await dragEnd(page, panel, id, 'head', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  expect(await colourOf(panel, id)).toBe(TEAL);
  expect(await dashOf(panel, id)).toBe('none');
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(0);
});

test('rule 11: a short circuit is refused: a tail onto a wire of another family, a head onto a wire of another family, a head of a teal net onto a red step', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`, ad = `${t.a}->${t.d}`;
  // a tail: b -> c (teal, its head on c) onto a -> d (red)
  const bcBefore = await pointsOf(panel, bc);
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, ad, 0.5, 12))).toBe('short circuit');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  expect(await pointsOf(panel, bc)).toEqual(bcBefore);
  // a head: a new wire from a, tapped on a -> d (red), its head onto a -> b (teal)
  const id = await newWire(page, panel, t.a, await emptySpot(panel));
  expect(await dragEnd(page, panel, id, 'tail', await pointOnWire(panel, ad, 0.5, 12))).toBe('join here');
  expect(await colourOf(panel, id)).toBe(RED);
  const idBefore = await pointsOf(panel, id);
  expect(await dragEnd(page, panel, id, 'head', await pointOnWire(panel, ab, 0.5, 12))).toBe('short circuit');
  expect(await pointsOf(panel, id)).toEqual(idBefore);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(1);
  // b -> c taps a -> b: one teal net that b and c decide; its head a -> b onto red d is refused
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  const before = await pointsOf(panel, ab);
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.d, 'in'))).toBe('short circuit');
  expect(await pointsOf(panel, ab)).toEqual(before);
  await expect(panel.locator('circle.nx-joint.short')).toHaveCount(0);
});

test('rule 12: an undecided wire is grey and dashed; open at both ends it keeps its ring and its arrow head', async ({ page }) => {
  const panel = await open(page);
  const spot = await emptySpot(panel);
  const id = await newWire(page, panel, t.a, spot);
  expect(await dragEnd(page, panel, id, 'tail', await emptySpot(panel, [spot]))).toBe('move here');
  expect(await colourOf(panel, id)).toBe(GREY);
  expect(await dashOf(panel, id)).not.toBe('none');
  await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(1);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(1);
  await expect(edge(panel, id).locator('circle.nx-open')).toHaveCount(0);
});

test('rule 13: a wire with one end open is dashed in its family\'s colour; with both ends connected, solid', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  expect(await dashOf(panel, ab)).toBe('none');
  expect(await dragEnd(page, panel, ab, 'tail', await emptySpot(panel))).toBe('move here');
  expect(await colourOf(panel, ab)).toBe(TEAL);
  expect(await dashOf(panel, ab)).not.toBe('none');
  expect(await dragEnd(page, panel, ab, 'tail', await onSide(panel, t.a, 'out'))).toBe('connect here');
  expect(await dashOf(panel, ab)).toBe('none');
  const ad = `${t.a}->${t.d}`;
  expect(await dragEnd(page, panel, ad, 'tail', await emptySpot(panel))).toBe('move here');
  expect(await colourOf(panel, ad)).toBe(RED);
  expect(await dashOf(panel, ad)).not.toBe('none');
});

test('rule 14: a picked wire shows its squares; its end squares show the four-way cursor, also while dragged', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  await expect(panel.locator(`.design-wire[data-wire="${ab}"] .design-handle`)).toHaveCount(0);
  await pickWire(page, panel, ab);
  await expect(panel.locator(`.design-wire[data-wire="${ab}"] .design-handle.end`)).toHaveCount(2);
  expect(await panel.locator(`.design-wire[data-wire="${ab}"] .design-handle.seg`).count()).toBeGreaterThanOrEqual(1);
  for (const side of ['tail', 'head'] as const) {
    const at = await centreOf(endSquare(panel, ab, side));
    await page.mouse.move(at.x, at.y);
    expect(await cursorAt(page, at)).toBe('move');
  }
  const at = await centreOf(endSquare(panel, ab, 'head'));
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y + 40, { steps: 4 });
  await expect(panel.locator('.studio-canvas')).toHaveClass(/gesture-move/);
  expect(await cursorAt(page, { x: at.x + 40, y: at.y + 40 })).toBe('move');
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('base circuit: current flows one way, from the hub to the steps: a tail never on a step\'s input, a head never on a step\'s output or the hub; a tail on the hub feeds its step', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  const before = await pointsOf(panel, ab);
  expect(await dragEnd(page, panel, ab, 'tail', await onSide(panel, t.c, 'in'))).toBe('wrong side');
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.c, 'out'))).toBe('wrong side');
  expect(await dragEnd(page, panel, ab, 'head', await onHub(panel, 315))).toBe('only a tail on the workflow');
  expect(await pointsOf(panel, ab)).toEqual(before);
  // the hub is all output: b -> c's tail goes on it; current from the hub into c, teal and solid
  expect(await dragEnd(page, panel, bc, 'tail', await onHub(panel, 45))).toBe('connect here');
  expect(await colourOf(panel, bc)).toBe(TEAL);
  expect(await dashOf(panel, bc)).toBe('none');
  // a wire from the hub's port into d's input: red, solid
  const id = await newWire(page, panel, 'wf', await onSide(panel, t.d, 'in'));
  expect(await colourOf(panel, id)).toBe(RED);
  expect(await dashOf(panel, id)).toBe('none');
});

test('a wire loop and a hidden self-loop are refused', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  // b -> c's head on a -> b would feed b its own input
  const bcBefore = await pointsOf(panel, `${t.b}->${t.c}`);
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'head', await pointOnWire(panel, ab, 0.5, 12))).toBe('same step');
  expect(await pointsOf(panel, `${t.b}->${t.c}`)).toEqual(bcBefore);
  // a new wire from d joined on a -> b, then a -> b's head on that wire: current would come back round wires alone
  const id = await newWire(page, panel, t.d, await pointOnWire(panel, ab, 0.5, 12));
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
  const before = await pointsOf(panel, ab);
  expect(await dragEnd(page, panel, ab, 'head', await pointOnWire(panel, id, 0.5, 12))).toBe('short circuit');
  expect(await pointsOf(panel, ab)).toEqual(before);
});

test('position along a wire decides what current reaches: a head joined before a tap reaches the tap\'s step, after it does not', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  // b -> c taps a -> b in its middle (fan-out)
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'tail', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  // a wire from c's output joined upstream of the tap would bring c's current back into c through the tap
  const id = await newWire(page, panel, t.c, await emptySpot(panel));
  expect(await dragEnd(page, panel, id, 'head', await pointOnWire(panel, ab, 0.15, 12))).toBe('same step');
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(0);
  // downstream of the tap it reaches b only: allowed (a loop through steps)
  expect(await dragEnd(page, panel, id, 'head', await pointOnWire(panel, ab, 0.85, 12))).toBe('join here');
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
  expect(await colourOf(panel, id)).toBe(TEAL);
});

test('an end dropped on a cache is "move here": the cache outlined grey, the end open there, the wire dashed', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  const cache = node(panel, `cache:${t.cacheId}`);
  await expect(cache).toBeVisible();
  await pickWire(page, panel, ab);
  const head = await centreOf(endSquare(panel, ab, 'head'));
  const over = await centreOf(cache);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(over.x, over.y, { steps: 10 });
  await expect(panel.locator('.design-drop-label')).toHaveText('move here');
  await expect(cache).toHaveClass(/drop-move/);
  await page.mouse.up();
  await expect(cache).not.toHaveClass(/drop-/);
  await expect(edge(panel, ab)).toHaveCount(1);
  expect(await dashOf(panel, ab)).not.toBe('none');
  expect(await colourOf(panel, ab)).toBe(GREY);
  await expect(edge(panel, ab).locator('path.nx-head')).toHaveCount(1);
  const tip = (await pointsOf(panel, ab)).at(-1)!;
  const cb = await flowBox(panel, `cache:${t.cacheId}`);
  expect(tip[0]).toBeGreaterThanOrEqual(cb.x - 8);
  expect(tip[0]).toBeLessThanOrEqual(cb.x + cb.w + 8);
  expect(tip[1]).toBeGreaterThanOrEqual(cb.y - 8);
  expect(tip[1]).toBeLessThanOrEqual(cb.y + cb.h + 8);
});

test('deleting a host leaves the wire joined on it open where it was, dashed', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  const joinedAt = (await pointsOf(panel, bc))[0]!;
  await pickWire(page, panel, ab);
  await page.keyboard.press('Delete');
  await expect(edge(panel, ab)).toHaveCount(0);
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  await expect(edge(panel, bc).locator('circle.nx-src')).toHaveCount(1);
  expect((await pointsOf(panel, bc))[0]).toEqual(joinedAt);
  expect(await dashOf(panel, bc)).not.toBe('none');
});

test('detaching a host (its tail dropped open) opens the end joined on it where it was drawn, dashed (spec §2.2-6)', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  const joinedAt = (await pointsOf(panel, bc))[0]!;
  expect(await dragEnd(page, panel, ab, 'tail', await emptySpot(panel))).toBe('move here');
  await expect(edge(panel, ab)).toHaveCount(1);
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  await expect(edge(panel, bc).locator('circle.nx-src')).toHaveCount(1);
  expect((await pointsOf(panel, bc))[0]).toEqual(joinedAt);
  expect(await dashOf(panel, bc)).not.toBe('none');
  // Undo puts the host back and the junction with it
  await page.keyboard.press('Control+z');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
});

test('a junction: Undo removes it, Redo brings it back, and a refresh keeps it', async ({ page }) => {
  const panel = await open(page);
  const bc = `${t.b}->${t.c}`;
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(edge(again, bc).locator('circle.nx-joint')).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('a tail at a hub angle, a slid head and an open head: Undo and Redo step through each, and a refresh keeps all three', async ({ page }) => {
  const panel = await open(page);
  const entry = `wf->${t.a}`, ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  const ids = [entry, ab, bc];
  const all = async (p: Locator) => Promise.all(ids.map((id) => pointsOf(p, id)));
  const original = await all(panel);
  const b = await flowBox(panel, t.b);
  expect(await dragEnd(page, panel, entry, 'tail', await onHub(panel, 270))).toBe('connect here');
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.b, 'in', 0.15))).toBe('connect here');
  expect(await dragEnd(page, panel, bc, 'head', await emptySpot(panel))).toBe('move here');
  near((await pointsOf(panel, entry))[0], await ringAt(panel, 270));
  expect((await pointsOf(panel, ab)).at(-1)).toEqual([b.x, b.y + 24]);
  expect(await dashOf(panel, bc)).not.toBe('none');
  const changed = await all(panel);
  await focusCanvas(page, panel);
  for (let i = 2; i >= 0; i--) {
    await page.keyboard.press('Control+z');
    await expect.poll(() => pointsOf(panel, ids[i]!)).toEqual(original[i]);
  }
  await expect(page.getByText('● design draft')).toHaveCount(0);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+y');
    await expect.poll(() => pointsOf(panel, ids[i]!)).toEqual(changed[i]);
  }
  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(edge(again, bc)).toHaveCount(1);
  await expect.poll(() => all(again)).toEqual(changed);
  await expect(edge(again, bc).locator('path.nx-head')).toHaveCount(1);
  expect(await dashOf(again, bc)).not.toBe('none');
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('an entry-condition edit that makes a short circuit marks the junction red and lists it in Problems', async ({ page }) => {
  const panel = await open(page);
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  await node(panel, t.c).click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText('STEP');
  await inspector(page).getByLabel('Entry condition', { exact: true }).click();
  await inspector(page).getByRole('option', { name: /Failed/ }).click();
  await expect(edge(panel, `${t.b}->${t.c}`).locator('circle.nx-joint.short')).toHaveCount(1);
  await tab(page, 'Problems').click();
  await expect(page.locator('[data-pane="problems"]')).toContainText('short circuit: Completed meets Failed');
});
