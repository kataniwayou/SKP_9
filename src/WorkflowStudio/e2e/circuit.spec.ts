import type { Locator, Page } from '@playwright/test';
import {
  box, centreOf, clearMove, documentPanel, dropOpen, flowToPage, dragEnd, dragReading, edge, emptySpot, endSquare, expect, newWire, node, openWorkflow,
  pickWire, pointOnWire, problems, setEntryCondition, test, type Pt,
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
  // neither the top nor the bottom of a step takes an end: dropped there it lands on a side (each end first slid to 144,
  // so the drop on the top edge has to move it)
  expect(await dragEnd(page, panel, `${t.a}->${t.b}`, 'head', await onSide(panel, t.b, 'in', 0.95))).toBe('connect here');
  expect((await pointsOf(panel, `${t.a}->${t.b}`)).at(-1)).toEqual([b.x, b.y + 144]);
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

test('rule 5: a head on a step\'s right side and a tail on its left side are refused ("wrong side"); a head on its own tail\'s step connects (free style, 2026-10-20); each slides along its own side', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  const before = await pointsOf(panel, ab);
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.b, 'out'))).toBe('wrong side');
  expect(await pointsOf(panel, ab)).toEqual(before);
  const bcBefore = await pointsOf(panel, bc);
  expect(await dragEnd(page, panel, bc, 'tail', await onSide(panel, t.b, 'in'))).toBe('wrong side');
  expect(await pointsOf(panel, bc)).toEqual(bcBefore);
  // a -> b's head on a's own input: both ends on one step, a step feeding itself (allowed, the user's ruling 2026-10-20)
  expect(await dragEnd(page, panel, ab, 'head', await onSide(panel, t.a, 'in'))).toBe('connect here');
  await expect.poll(async () => (await pointsOf(panel, ab)).at(-1)![0]).toBe((await flowBox(panel, t.a)).x);
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
  await pickWire(page, panel, ab);
  const head = await centreOf(endSquare(panel, ab, 'head'));
  const over = await onHub(panel, 0);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(over.x, over.y, { steps: 10 });
  // while held over the hub: the red refusal, and the hub outlined as a refused drop
  await expect(panel.locator('.design-drop-label')).toHaveText('only a tail on the workflow');
  await expect(node(panel, 'wf')).toHaveClass(/drop-no/);
  await page.mouse.up();
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

test('rule 8: a tail joined to a teal wire is teal while its head gives it a direction; with its head open it is just a wire, grey (the user\'s rule 1, 2026-10-09)', async ({ page }) => {
  const panel = await open(page);
  const id = await newWire(page, panel, t.a, await onSide(panel, t.c, 'in'));
  expect(await colourOf(panel, id)).toBe(TEAL);
  expect(await dragEnd(page, panel, id, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  expect(await colourOf(panel, id)).toBe(TEAL);
  expect(await dashOf(panel, id)).toBe('none'); // both its ends connected
  // its head open: no end on a step, so no direction, and no colour through the junction
  await dropOpen(page, panel, async () => { await pickWire(page, panel, id); return centreOf(endSquare(panel, id, 'head')); });
  expect(await colourOf(panel, id)).toBe(GREY);
  expect(await dashOf(panel, id)).not.toBe('none');
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
  // a head: a new wire from a made red by a tap on it that feeds red d, its head onto a -> b (teal)
  const spot = await emptySpot(panel);
  const id = await newWire(page, panel, t.a, spot);
  const tap = await newWire(page, panel, t.b, await emptySpot(panel, [spot]));
  expect(await dragEnd(page, panel, tap, 'tail', await pointOnWire(panel, id, 0.5, 12))).toBe('join here');
  expect(await dragEnd(page, panel, tap, 'head', await onSide(panel, t.d, 'in'))).toBe('connect here');
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

test('rule 12: an undecided wire is grey and dashed; open at both ends it has no direction: no ring, no arrow head (rule D, 2026-10-09)', async ({ page }) => {
  const panel = await open(page);
  const spot = await emptySpot(panel);
  const id = await newWire(page, panel, t.a, spot);
  await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(1);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(1);
  expect(await dragEnd(page, panel, id, 'tail', await emptySpot(panel, [spot]))).toBe('move here');
  expect(await colourOf(panel, id)).toBe(GREY);
  expect(await dashOf(panel, id)).not.toBe('none');
  await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(0);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(0);
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

test('rule 14: a picked wire shows its squares; its end squares show the four-way cursor, the crosshair while dragged (plan 10)', async ({ page }) => {
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
  // held, Visio's crosshair while the end is placed (plan 10 phase 2)
  await expect(panel.locator('.studio-canvas')).toHaveClass(/gesture-cross/);
  expect(await cursorAt(page, { x: at.x + 40, y: at.y + 40 })).toBe('crosshair');
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
  near((await pointsOf(panel, bc))[0], await ringAt(panel, 45));
  expect(await colourOf(panel, bc)).toBe(TEAL);
  expect(await dashOf(panel, bc)).toBe('none');
  // a wire from the hub's port into d's input: red, solid
  const id = await newWire(page, panel, 'wf', await onSide(panel, t.d, 'in'));
  expect(await colourOf(panel, id)).toBe(RED);
  expect(await dashOf(panel, id)).toBe('none');
});

test('a wire loop is refused; a hidden self-loop joins (free style, 2026-10-20)', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  // b -> c's head on a -> b feeds b its own input: allowed now; undone again
  const bcBefore = await pointsOf(panel, `${t.b}->${t.c}`);
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'head', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  await expect(edge(panel, `${t.b}->${t.c}`).locator('circle.nx-joint')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => pointsOf(panel, `${t.b}->${t.c}`)).toEqual(bcBefore);
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
  // a wire from c's output joined upstream of the tap brings c's current back into c through the tap (allowed, 2026-10-20)
  const id = await newWire(page, panel, t.c, await emptySpot(panel));
  expect(await dragEnd(page, panel, id, 'head', await pointOnWire(panel, ab, 0.15, 12))).toBe('join here');
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
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

test('an entry-condition edit that makes a short circuit marks the junction red and pins it in Output', async ({ page }) => {
  const panel = await open(page);
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  await setEntryCondition(page, panel, t.c, /Failed/);
  await expect(edge(panel, `${t.b}->${t.c}`).locator('circle.nx-joint.short')).toHaveCount(1);
  await expect(await problems(page)).toContainText('short circuit: Completed meets Failed');
});

// ---- the user's drag rules (2026-10-08): the body moves the whole wire; an end square adds one corner ----

/** Every point of `after` is the point of `before` shifted by the same (dx, dy); that shift. */
function shiftOf(before: [number, number][], after: [number, number][]): { dx: number; dy: number } {
  expect(after.length, 'the same number of points: the same shape').toBe(before.length);
  const dx = after[0]![0] - before[0]![0], dy = after[0]![1] - before[0]![1];
  after.forEach((p, i) => near(p, [before[i]![0] + dx, before[i]![1] + dy]));
  return { dx, dy };
}

test('drag rules: Visio\'s four-way arrow on a wire\'s body, also while it is dragged; two-headed arrows on run squares, the four-headed one on end squares (plan 10)', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  const before = await pointsOf(panel, ab);
  // not picked: the four-way arrow
  let body = await pointOnWire(panel, ab, 0.3);
  await page.mouse.move(body.x, body.y);
  expect(await cursorAt(page, body)).toBe('move');
  await pickWire(page, panel, ab);
  const runs = await panel.locator(`.design-wire[data-wire="${ab}"] .design-handle.seg`).all();
  expect(runs.length).toBeGreaterThanOrEqual(1);
  for (const run of runs) {
    const c = await centreOf(run);
    await page.mouse.move(c.x, c.y);
    expect(await cursorAt(page, c)).toBe(/\bh\b/.test((await run.getAttribute('class')) ?? '') ? 'ns-resize' : 'ew-resize');
  }
  for (const side of ['tail', 'head'] as const) {
    const c = await centreOf(endSquare(panel, ab, side));
    await page.mouse.move(c.x, c.y);
    expect(await cursorAt(page, c)).toBe('move');
  }
  // picked: still the four-way arrow off the squares; pressed and dragged, the four-way arrow on the canvas the whole way
  body = await pointOnWire(panel, ab, 0.3);
  await page.mouse.move(body.x, body.y);
  expect(await cursorAt(page, body)).toBe('move');
  await page.mouse.down();
  for (const [dx, dy] of [[16, 24], [40, 64], [72, 96]] as const) {
    await page.mouse.move(body.x + dx, body.y + dy, { steps: 3 });
    await expect(panel.locator('.studio-canvas')).toHaveClass(/\bgesture-move\b/);
    await expect(panel.locator('.studio-canvas')).not.toHaveClass(/gesture-(ns|ew|cross)/);
    expect(await cursorAt(page, { x: body.x + dx, y: body.y + dy })).toBe('move');
  }
  // Escape puts it back
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, ab)).toEqual(before);
});

test('drag rules: a wire dragged by its body moves whole (every point shifted by one grid-snapped amount), opens at both ends (grey, dashed) and opens the end joined on it; one Undo step; a refresh keeps it', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  const joinedAt = (await pointsOf(panel, bc))[0]!;
  const before = await pointsOf(panel, ab);
  expect(await colourOf(panel, ab)).toBe(TEAL);
  expect(await dashOf(panel, ab)).toBe('none');
  // not picked: a press on its body is enough
  await focusCanvas(page, panel);
  const from = await pointOnWire(panel, ab, 0.2);
  // somewhere both its ends land on empty canvas (an end over a step or a line would connect there, rule B)
  const by = await clearMove(panel, ab);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 4 });
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, ab)).not.toEqual(before);
  const after = await pointsOf(panel, ab);
  const { dx, dy } = shiftOf(before, after);
  expect(Math.abs(dx % 8)).toBe(0);
  expect(Math.abs(dy % 8)).toBe(0);
  expect(Math.sign(dx)).toBe(Math.sign(by.x));
  expect(Math.sign(dy)).toBe(Math.sign(by.y));
  // both ends open: no family, grey and dashed; no end on a step, so no direction: no ring, no arrow head (rule D)
  expect(await colourOf(panel, ab)).toBe(GREY);
  expect(await dashOf(panel, ab)).not.toBe('none');
  await expect(edge(panel, ab).locator('circle.nx-src')).toHaveCount(0);
  await expect(edge(panel, ab).locator('path.nx-head')).toHaveCount(0);
  // the tail joined on it is open where it was drawn
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  await expect(edge(panel, bc).locator('circle.nx-src')).toHaveCount(1);
  expect((await pointsOf(panel, bc))[0]).toEqual(joinedAt);
  expect(await dashOf(panel, bc)).not.toBe('none');
  // it is the pick: its squares show
  await expect(endSquare(panel, ab, 'head')).toBeVisible();

  // one step: Undo puts the wire back where it was, connected, and the junction with it; Redo moves it again
  await focusCanvas(page, panel);
  await page.keyboard.press('Control+z');
  await expect.poll(() => pointsOf(panel, ab)).toEqual(before);
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
  expect(await dashOf(panel, ab)).toBe('none');
  await page.keyboard.press('Control+y');
  await expect.poll(() => pointsOf(panel, ab)).toEqual(after);
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);

  // a refresh keeps it (the draft is in the session; the history is not)
  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(edge(again, ab)).toHaveCount(1);
  await expect.poll(() => pointsOf(again, ab)).toEqual(after);
  expect(await dashOf(again, ab)).not.toBe('none');
  await expect(edge(again, bc).locator('circle.nx-joint')).toHaveCount(0);
  expect((await pointsOf(again, bc))[0]).toEqual(joinedAt);
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('drag rules: an end square dragged across its last run adds one corner (an L); the new leg dragged across adds one more; dropped on a step it connects again', async ({ page }) => {
  const panel = await open(page);
  const bc = `${t.b}->${t.c}`;
  const straight = await pointsOf(panel, bc);
  expect(straight.length, 'b -> c is straight').toBe(2);
  expect(straight[0]![1]).toBe(straight[1]![1]);
  // its head down, off c: one vertical leg; the horizontal run lengthened or shortened to the pointer's x, nothing else moved
  await pickWire(page, panel, bc);
  const head = await centreOf(endSquare(panel, bc, 'head'));
  expect(await dragReading(page, panel, head, { x: head.x, y: head.y + 96 })).toBe('move here');
  await expect.poll(async () => (await pointsOf(panel, bc)).length).toBe(3);
  const l = await pointsOf(panel, bc);
  expect(l[0]).toEqual(straight[0]);
  expect(l[1]![1]).toBe(straight[0]![1]);
  expect(l[2]![0]).toBe(l[1]![0]);
  expect(l[2]![1]).toBeGreaterThan(l[1]![1]);
  near(l[1], straight[1]!);
  expect(await dashOf(panel, bc)).not.toBe('none');

  // the vertical leg's end dragged sideways: one horizontal leg more, the L kept
  const end = await centreOf(endSquare(panel, bc, 'head'));
  expect(await dragReading(page, panel, end, { x: end.x + 96, y: end.y })).toBe('move here');
  await expect.poll(async () => (await pointsOf(panel, bc)).length).toBe(4);
  const z = await pointsOf(panel, bc);
  expect(z.slice(0, 3)).toEqual(l);
  expect(z[3]![1]).toBe(l[2]![1]);
  expect(z[3]![0]).toBeGreaterThan(l[2]![0]);

  // the tail of a -> d dragged down off a: one corner at the tail
  const ad = `${t.a}->${t.d}`;
  const adBefore = await pointsOf(panel, ad);
  await pickWire(page, panel, ad);
  const tail = await centreOf(endSquare(panel, ad, 'tail'));
  const aBox = await box(node(panel, t.a));
  expect(await dragReading(page, panel, tail, { x: tail.x, y: aBox.y + aBox.height + 48 })).toBe('move here');
  await expect.poll(async () => (await pointsOf(panel, ad)).length).toBe(adBefore.length + 1);
  const adL = await pointsOf(panel, ad);
  expect(adL.slice(2)).toEqual(adBefore.slice(1));
  expect(adL[1]).toEqual(adBefore[0]);
  expect(adL[0]![0]).toBe(adBefore[0]![0]);

  // b -> c's head back on c's input: connected again, solid
  expect(await dragEnd(page, panel, bc, 'head', await onSide(panel, t.c, 'in'))).toBe('connect here');
  expect(await dashOf(panel, bc)).toBe('none');
  expect((await pointsOf(panel, bc)).at(-1)![0]).toBe((await flowBox(panel, t.c)).x);
});

// ---- the user's drag rules (2026-10-09): B body drag lands each end, C an end square draws around corners, D wires
// with no end on a step or the hub have no direction ----

/** Two animation frames, so what is drawn is for the last pointer move. */
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
const labelsOf = (panel: Locator) => panel.locator('.design-drop-label').allTextContents();
/** Flow px per screen px is 1 / this: the canvas's zoom. */
async function zoomOf(panel: Locator): Promise<number> {
  const a = await flowToPage(panel, [0, 0]), b = await flowToPage(panel, [100, 0]);
  return (b.x - a.x) / 100;
}

/** A new wire from step `from` with both its ends then moved open: no end on a step or the hub, direction-less. */
async function freeWire(page: Page, panel: Locator, from: string, avoid: Pt[] = []): Promise<string> {
  const spot = await emptySpot(panel, avoid);
  const id = await newWire(page, panel, from, spot);
  expect(await dragEnd(page, panel, id, 'tail', await emptySpot(panel, [spot, ...avoid]))).toBe('move here');
  await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(0);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(0);
  return id;
}

test('cursors (rule A, Visio\'s since plan 10): four-way on a wire\'s body and on end squares, two-way on run squares; four-way while the body is dragged', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  await pickWire(page, panel, ab);
  const squares = await panel.locator(`.design-wire[data-wire="${ab}"] .design-handle`).all();
  expect(squares.length).toBeGreaterThanOrEqual(3);
  for (const sq of squares) {
    const c = await centreOf(sq);
    await page.mouse.move(c.x, c.y);
    const cls = (await sq.getAttribute('class')) ?? '';
    expect(await cursorAt(page, c)).toBe(/\bend\b/.test(cls) ? 'move' : /\bh\b/.test(cls) ? 'ns-resize' : 'ew-resize');
  }
  const body = await pointOnWire(panel, ab, 0.3);
  await page.mouse.move(body.x, body.y);
  expect(await cursorAt(page, body)).toBe('move');
  await page.mouse.down();
  await page.mouse.move(body.x + 40, body.y + 60, { steps: 4 });
  expect(await cursorAt(page, { x: body.x + 40, y: body.y + 60 })).toBe('move');
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('rule B: a connected wire dragged away by its body and dropped back where it was connects at both ends again, solid and in its colour; a grid step lower it connects there, its shape exactly as moved', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  const before = await pointsOf(panel, ab);
  const from = await pointOnWire(panel, ab, 0.5);
  const away = await clearMove(panel, ab);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + away.x, from.y + away.y, { steps: 8 });
  await frames(page);
  // away: both ends open, each labelled; the wire stays put, faded, and where it lands is the dashed preview (Visio, plan 10)
  expect(await labelsOf(panel)).toEqual(['move here', 'move here']);
  await expect(panel.locator('path.design-ghost')).toHaveCount(1);
  await expect(edge(panel, ab).locator('g.wire.faded')).toHaveCount(1);
  expect(await pointsOf(panel, ab)).toEqual(before);
  // back where it was pressed: both ends are over their sides again, each block outlined green
  await page.mouse.move(from.x, from.y, { steps: 8 });
  await frames(page);
  expect(await labelsOf(panel)).toEqual(['connect here', 'connect here']);
  await expect(node(panel, t.a)).toHaveClass(/drop-ok/);
  await expect(node(panel, t.b)).toHaveClass(/drop-ok/);
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, ab)).toEqual(before);
  expect(await dashOf(panel, ab)).toBe('none');
  expect(await colourOf(panel, ab)).toBe(TEAL);
  await expect(edge(panel, ab).locator('circle.nx-src')).toHaveCount(1);
  await expect(edge(panel, ab).locator('path.nx-head')).toHaveCount(1);

  // away again and back 16 lower: both ends connect there (slid down their sides), the shape exactly as moved
  const z = await zoomOf(panel);
  const again = await pointOnWire(panel, ab, 0.5);
  const away2 = await clearMove(panel, ab);
  await page.mouse.move(again.x, again.y);
  await page.mouse.down();
  await page.mouse.move(again.x + away2.x, again.y + away2.y, { steps: 8 });
  await page.mouse.move(again.x, again.y + 16 * z, { steps: 8 });
  await frames(page);
  expect(await labelsOf(panel)).toEqual(['connect here', 'connect here']);
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, ab)).not.toEqual(before);
  const lower = await pointsOf(panel, ab);
  expect(shiftOf(before, lower)).toEqual({ dx: 0, dy: 16 });
  expect(await dashOf(panel, ab)).toBe('none');
  expect(await colourOf(panel, ab)).toBe(TEAL);
  await expect(edge(panel, ab).locator('circle.nx-src')).toHaveCount(1);
  await expect(edge(panel, ab).locator('path.nx-head')).toHaveCount(1);
});

test('rule B: a wire with one end still connected, dragged by its body, moves whole: its shape frozen, that end detached (the closed hand never stretches a leg)', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  // its head open first (its end square, at a spot whose leg lies on no other wire: rule 2): the tail stays on a
  await dropOpen(page, panel, async () => { await pickWire(page, panel, ab); return centreOf(endSquare(panel, ab, 'head')); });
  const before = await pointsOf(panel, ab);
  const a = await flowBox(panel, t.a);
  expect(before[0]![0]).toBe(a.x + a.w);
  const from = await pointOnWire(panel, ab, 0.5);
  const by = await clearMove(panel, ab);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 4 });
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, ab)).not.toEqual(before);
  const after = await pointsOf(panel, ab);
  // every point moved by one amount: no leg stretched to keep the tail on a
  const { dx, dy } = shiftOf(before, after);
  expect(Math.hypot(dx, dy)).toBeGreaterThan(0);
  expect(after[0]![0]).not.toBe(a.x + a.w);
  // no end on a step now: grey, dashed, direction-less
  expect(await colourOf(panel, ab)).toBe(GREY);
  expect(await dashOf(panel, ab)).not.toBe('none');
  await expect(edge(panel, ab).locator('circle.nx-src')).toHaveCount(0);
  await expect(edge(panel, ab).locator('path.nx-head')).toHaveCount(0);
});

test('rule B with D: both ends of a moved wire over one step\'s input: the first connects (it is the head), the second is "wrong side" (red) and stays open, moved with the wire', async ({ page }) => {
  const panel = await open(page);
  const id = `wf->${t.a}`;
  // a moved 64 nearer the hub, so its wire is shorter than half a step (the layout's gap is 128 since plan 10 phase 3)
  const grab = await centreOf(node(panel, t.a).locator('.nx-sn')), zoom = await zoomOf(panel);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x - 20, grab.y, { steps: 3 });
  await page.mouse.move(grab.x - 64 * zoom, grab.y, { steps: 6 });
  await page.mouse.up();
  const before = await pointsOf(panel, id);
  expect(before).toHaveLength(2);
  expect(before[1]![0] - before[0]![0]).toBe(64);
  const b = await flowBox(panel, t.b);
  // its tail end into b's input half, 16 short of the side; its head end 64 further in; a track (32) below b's processor
  // middle, where a -> b lands, so neither end is within a line's reach of it
  const dx = b.x + 16 - before[0]![0], dy = b.y + 128 - before[0]![1];
  const z = await zoomOf(panel);
  const from = await pointOnWire(panel, id, 0.5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // under b first, then straight up into it, so both ends arrive at once (from the left, the right end would get
  // there first and connect alone, the other end left open short of b)
  await page.mouse.move(from.x + dx * z, from.y + (dy + 240) * z, { steps: 6 });
  await frames(page);
  expect(await labelsOf(panel)).toEqual(['move here', 'move here']);
  await page.mouse.move(from.x + dx * z, from.y + dy * z, { steps: 6 });
  await frames(page);
  expect(await labelsOf(panel)).toEqual(['connect here', 'wrong side']);
  await expect(panel.locator('.design-drop-label.no')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, id)).not.toEqual(before);
  const after = await pointsOf(panel, id);
  // the end that reached b first is its head now, on b's input side; the other is its tail, open where it was moved to
  expect(after.at(-1)).toEqual([b.x, b.y + 128]);
  expect(after[0]).toEqual([b.x + 64, b.y + 128]);
  expect(await colourOf(panel, id)).toBe(TEAL);
  expect(await dashOf(panel, id)).not.toBe('none');
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(1);
});

test('rule C: an end square draws its wire around corners in one drag: three turns of the pointer, three corners, each kept', async ({ page }) => {
  const panel = await open(page);
  const bc = `${t.b}->${t.c}`;
  const straight = await pointsOf(panel, bc);
  expect(straight).toHaveLength(2);
  const [tx, ty] = straight[0]!, [hx, hy] = straight[1]!;
  await pickWire(page, panel, bc);
  const head = await centreOf(endSquare(panel, bc, 'head'));
  // down below c, right, down again: one gesture
  const legs: [number, number][] = [[hx, hy + 128], [hx + 96, hy + 128], [hx + 96, hy + 208]];
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  for (const p of legs) {
    const q = await flowToPage(panel, p);
    await page.mouse.move(q.x, q.y, { steps: 10 });
  }
  await frames(page);
  expect(await labelsOf(panel)).toEqual(['move here']);
  await page.mouse.up();
  await expect.poll(async () => (await pointsOf(panel, bc)).length).toBe(5);
  const p = await pointsOf(panel, bc);
  expect(p[0]).toEqual([tx, ty]);
  const close = (a: [number, number], b: [number, number]) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(8);
  close(p[1]!, [hx, ty]);
  close(p[2]!, [hx, hy + 128]);
  close(p[3]!, [hx + 96, hy + 128]);
  close(p[4]!, [hx + 96, hy + 208]);
  // right angles all the way: horizontal, vertical, horizontal, vertical
  expect([p[0]![1] === p[1]![1], p[1]![0] === p[2]![0], p[2]![1] === p[3]![1], p[3]![0] === p[4]![0]]).toEqual([true, true, true, true]);
  expect(await dashOf(panel, bc)).not.toBe('none');
});

test('rule C: the corners drawn are kept when the end connects; only the last leg goes into the contact', async ({ page }) => {
  const panel = await open(page);
  const id = `wf->${t.a}`;
  const before = await pointsOf(panel, id);
  const [hx, hy] = before.at(-1)!;
  const b = await flowBox(panel, t.b);
  await pickWire(page, panel, id);
  const head = await centreOf(endSquare(panel, id, 'head'));
  // down under a and below b, right to short of b, up, then right into b's input half (clear of a -> b, which drops on
  // x 552 above b's input: the corners kept, the route drawn must not lie on it, the user's rule 2 — 2026-10-20)
  const legs: [number, number][] = [[hx, b.y + 176], [b.x - 32, b.y + 176], [b.x - 32, b.y + 128], [b.x + 24, b.y + 128]];
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  for (const q of legs) {
    const at = await flowToPage(panel, q);
    await page.mouse.move(at.x, at.y, { steps: 10 });
  }
  await frames(page);
  expect(await labelsOf(panel)).toEqual(['connect here']);
  await page.mouse.up();
  await expect.poll(async () => (await pointsOf(panel, id)).at(-1)).toEqual([b.x, b.y + 128]);
  const p = await pointsOf(panel, id);
  const close = (a: [number, number] | undefined, q: [number, number]) => expect(Math.hypot(a![0] - q[0], a![1] - q[1])).toBeLessThanOrEqual(8);
  expect(p[0]).toEqual(before[0]);
  close(p[1], [hx, hy]);
  close(p[2], [hx, b.y + 176]);
  // the last upright keeps its heights; the router squares it into the contact a lead of up to 16 px nearer b
  close(p[3], [p[3]![0], b.y + 176]);
  close(p[4], [p[3]![0], b.y + 128]);
  expect(Math.abs(p[3]![0] - (b.x - 32))).toBeLessThanOrEqual(16);
  expect(p).toHaveLength(6);
  // connected to b: in b's colour, solid
  expect(await colourOf(panel, id)).toBe(TEAL);
  expect(await dashOf(panel, id)).toBe('none');
});

test('rule D: a direction-less wire has no ring and no arrow head; its first end on an output side is its tail (the arrow head goes to the other end), on an input side its head', async ({ page }) => {
  const panel = await open(page);
  const id = await freeWire(page, panel, t.c);
  const was = await pointsOf(panel, id);
  // its "head" end onto d's output: never the wrong side; that end is its tail now
  expect(await dragEnd(page, panel, id, 'head', await onSide(panel, t.d, 'out'))).toBe('connect here');
  const d = await flowBox(panel, t.d);
  await expect.poll(async () => (await pointsOf(panel, id))[0]![0]).toBe(d.x + d.w);
  const p = await pointsOf(panel, id);
  expect(p.at(-1)).toEqual(was[0]);
  await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(1);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(1);
  const ring = await centreOf(edge(panel, id).locator('circle.nx-src'));
  const dBox = await box(node(panel, t.d));
  expect(Math.abs(ring.x - (dBox.x + dBox.width))).toBeLessThan(6);

  // another: its "tail" end onto c's input: that end is its head, the arrow head on c's input side
  const other = await freeWire(page, panel, t.a, [ring]);
  const was2 = await pointsOf(panel, other);
  expect(await dragEnd(page, panel, other, 'tail', await onSide(panel, t.c, 'in'))).toBe('connect here');
  const c = await flowBox(panel, t.c);
  await expect.poll(async () => (await pointsOf(panel, other)).at(-1)![0]).toBe(c.x);
  expect((await pointsOf(panel, other))[0]).toEqual(was2.at(-1));
  await expect(edge(panel, other).locator('path.nx-head')).toHaveCount(1);
  await expect(edge(panel, other).locator('circle.nx-src')).toHaveCount(1);
  expect(await colourOf(panel, other)).toBe(TEAL);
});

test('rule D: a direction-less wire joined on a line, then onto a step: an output makes it the tail there (its junction the head), an input the head (its junction the tail)', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  const id = await freeWire(page, panel, t.c);
  expect(await dragEnd(page, panel, id, 'tail', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
  await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(0);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(0);
  // its other end onto d's output: d is its tail, the junction its head (current from d into a -> b)
  expect(await dragEnd(page, panel, id, 'head', await onSide(panel, t.d, 'out'))).toBe('connect here');
  const d = await flowBox(panel, t.d);
  await expect.poll(async () => (await pointsOf(panel, id))[0]![0]).toBe(d.x + d.w);
  await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(1);
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(0);

  // another joined on a -> b, its other end onto c's input: c is its head, the junction its tail (a tap)
  const other = await freeWire(page, panel, t.a);
  expect(await dragEnd(page, panel, other, 'head', await pointOnWire(panel, ab, 0.25, 12))).toBe('join here');
  expect(await dragEnd(page, panel, other, 'tail', await onSide(panel, t.c, 'in'))).toBe('connect here');
  const c = await flowBox(panel, t.c);
  await expect.poll(async () => (await pointsOf(panel, other)).at(-1)![0]).toBe(c.x);
  await expect(edge(panel, other).locator('path.nx-head')).toHaveCount(1);
  await expect(edge(panel, other).locator('circle.nx-joint')).toHaveCount(1);
  await expect(edge(panel, other).locator('circle.nx-src')).toHaveCount(0);
  expect(await colourOf(panel, other)).toBe(TEAL);
  expect(await dashOf(panel, other)).toBe('none');
});

test('rule D: a direction-less wire joined on one line is refused on a second: "needs a step first", and its end stays where it was', async ({ page }) => {
  const panel = await open(page);
  const id = await freeWire(page, panel, t.c);
  expect(await dragEnd(page, panel, id, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  const before = await pointsOf(panel, id);
  expect(await dragEnd(page, panel, id, 'head', await pointOnWire(panel, `${t.b}->${t.c}`, 0.5, 12))).toBe('needs a step first');
  await expect(panel.locator('.design-drop-label')).toHaveCount(0);
  expect(await pointsOf(panel, id)).toEqual(before);
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
});

test('rule D: a refresh keeps direction-less wires as they are: no ring, no arrow head, the junction kept', async ({ page }) => {
  const panel = await open(page);
  const open1 = await freeWire(page, panel, t.c);
  const joined = await freeWire(page, panel, t.a);
  expect(await dragEnd(page, panel, joined, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  const a = await pointsOf(panel, open1), j = await pointsOf(panel, joined);
  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(edge(again, open1)).toHaveCount(1);
  await expect.poll(() => pointsOf(again, open1)).toEqual(a);
  await expect.poll(() => pointsOf(again, joined)).toEqual(j);
  for (const id of [open1, joined]) {
    await expect(edge(again, id).locator('circle.nx-src')).toHaveCount(0);
    await expect(edge(again, id).locator('path.nx-head')).toHaveCount(0);
    expect(await dashOf(again, id)).not.toBe('none');
  }
  await expect(edge(again, joined).locator('circle.nx-joint')).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});

// ---- review fixes (2026-10-09) ----

test('rule D, lifted: a wire whose only step end is dragged has no direction while lifted: onto an input it is the head; joined on a line, that end onto a second line is "needs a step first"', async ({ page }) => {
  const panel = await open(page);
  // a new wire from c, open at its head: its tail onto d's input is not "wrong side" but makes that end its head
  const spot = await emptySpot(panel);
  const id = await newWire(page, panel, t.c, spot);
  expect(await dragEnd(page, panel, id, 'tail', await onSide(panel, t.d, 'in'))).toBe('connect here');
  const d = await flowBox(panel, t.d);
  await expect.poll(async () => (await pointsOf(panel, id)).at(-1)![0]).toBe(d.x);
  await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(1);
  // another from c, its head joined on a -> b: its tail (its only step end) onto b -> c's line is refused
  const other = await newWire(page, panel, t.c, await emptySpot(panel, [spot]));
  expect(await dragEnd(page, panel, other, 'head', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  const before = await pointsOf(panel, other);
  expect(await dragEnd(page, panel, other, 'tail', await pointOnWire(panel, `${t.a}->${t.d}`, 0.5, 12))).toBe('needs a step first');
  expect(await pointsOf(panel, other)).toEqual(before);
});

test('rule D, turned: the ends joined on a direction-less wire stay where they are when it gets its direction', async ({ page }) => {
  const panel = await open(page);
  const k = await freeWire(page, panel, t.c);
  // a wire from a, its head joined on k near k's stored head
  const g = await newWire(page, panel, t.a, await emptySpot(panel));
  expect(await dragEnd(page, panel, g, 'head', await pointOnWire(panel, k, 0.8, 12))).toBe('join here');
  const dot = await centreOf(edge(panel, g).locator('circle.nx-joint'));
  // k's stored tail onto c's input: k is turned round (that end its head)
  expect(await dragEnd(page, panel, k, 'tail', await onSide(panel, t.c, 'in'))).toBe('connect here');
  await expect(edge(panel, k).locator('path.nx-head')).toHaveCount(1);
  const now = await centreOf(edge(panel, g).locator('circle.nx-joint'));
  expect(Math.hypot(now.x - dot.x, now.y - dot.y)).toBeLessThan(12);
});

test('rule B on the hub: an entry wire moved down a little lands on the ring and on its step again, everything stored on the grid', async ({ page }) => {
  const panel = await open(page);
  const id = `wf->${t.a}`;
  const before = await pointsOf(panel, id);
  const z = await zoomOf(panel);
  const from = await pointOnWire(panel, id, 0.5);
  const away = await clearMove(panel, id);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + away.x, from.y + away.y, { steps: 6 });
  await page.mouse.move(from.x, from.y + 24 * z, { steps: 6 });
  await frames(page);
  expect(await labelsOf(panel)).toEqual(['connect here', 'connect here']);
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, id)).not.toEqual(before);
  const after = await pointsOf(panel, id);
  // after the ring point and its short jog, every point is on the grid; the head on a's input
  const a = await flowBox(panel, t.a);
  expect(after.at(-1)![0]).toBe(a.x);
  for (const p of after.slice(2)) expect([p[0] % 8, p[1] % 8].map(Math.abs)).toEqual([0, 0]);
  expect(await dashOf(panel, id)).toBe('none');
});

// on the hub at 45 degrees: at 0 its tail would lie on the hub's own entry wire's line (a short circuit, the user's rule 2)
for (const [where, onto] of [['the hub', (panel: Locator) => onHub(panel, 45)], ['an output', (panel: Locator) => onSide(panel, t.d, 'out')]] as const) {
  test(`rule D, turned: a direction-less wire's stored head dropped on ${where} is its tail now; an end joined on it near the end that stayed does not move`, async ({ page }) => {
    const panel = await open(page);
    const k = await freeWire(page, panel, t.c);
    // a wire from a, its head joined on k near k's stored tail (the end that stays)
    const g = await newWire(page, panel, t.a, await emptySpot(panel));
    expect(await dragEnd(page, panel, g, 'head', await pointOnWire(panel, k, 0.2, 12))).toBe('join here');
    const dot = await centreOf(edge(panel, g).locator('circle.nx-joint'));
    expect(await dragEnd(page, panel, k, 'head', await onto(panel))).toBe('connect here');
    await expect(edge(panel, k).locator('circle.nx-src')).toHaveCount(1);
    const now = await centreOf(edge(panel, g).locator('circle.nx-joint'));
    expect(Math.hypot(now.x - dot.x, now.y - dot.y)).toBeLessThan(4);
  });
}

// ---- the user's cut rule (2026-10-09): an end square released on its own wire's squares ----

/** A picked wire's run square k. */
const runSquare = (panel: Locator, id: string, k: number) => panel.locator(`.design-wire[data-wire="${id}"] .design-handle.seg[data-k="${k}"]`);

/** Presses `from` and moves the real mouse to `to` in small steps; the button stays down. */
async function pressTo(page: Page, from: Pt, to: Pt): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await frames(page);
}

test('cut: an end square released on one of its own run squares cuts the wire there: the corners before it kept, those after it gone, the end open there; Ctrl+Z puts it back', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  const before = await pointsOf(panel, ab);
  expect(before).toHaveLength(4);
  await pickWire(page, panel, ab);
  // run 1 is a -> b's vertical run: its square is in its middle
  const sq = await centreOf(runSquare(panel, ab, 1));
  await pressTo(page, await centreOf(endSquare(panel, ab, 'head')), sq);
  // hovering: "cut here", the part that goes drawn faded, the wire drawn up to the square
  expect(await labelsOf(panel)).toEqual(['cut here']);
  await expect(panel.locator('.design-gone')).toHaveCount(1);
  // the run's middle on the 8 px grid: where its square is and where it cuts
  const mid: [number, number] = [before[1]![0], Math.round((before[1]![1] + before[2]![1]) / 16) * 8];
  // the wire stays put meanwhile; the part kept is the dashed preview (Visio, plan 10 phase 2)
  const ghost = async () => [...((await panel.locator('path.design-ghost').getAttribute('d')) ?? '').matchAll(/[ML]([-\d.e]+)[ ,]([-\d.e]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  await expect.poll(ghost).toEqual([before[0], before[1], mid]);
  expect(await pointsOf(panel, ab)).toEqual(before);
  // the squares stay where they were when the drag began
  expect(await centreOf(runSquare(panel, ab, 1))).toEqual(sq);
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, ab)).toEqual([before[0], before[1], mid]);
  // the corner after the square is gone; the head is open there: dashed, grey, its arrow head at the cut
  expect(await dashOf(panel, ab)).not.toBe('none');
  expect(await colourOf(panel, ab)).toBe(GREY);
  await expect(edge(panel, ab).locator('path.nx-head')).toHaveCount(1);
  await expect(panel.locator('.design-gone')).toHaveCount(0);
  // one step back
  await focusCanvas(page, panel);
  await page.keyboard.press('Control+z');
  await expect.poll(() => pointsOf(panel, ab)).toEqual(before);
  expect(await dashOf(panel, ab)).toBe('none');
});

test('cut: moving off the square restores the drag as before; Escape over the square cancels everything', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  const before = await pointsOf(panel, ab);
  await pickWire(page, panel, ab);
  const sq = await centreOf(runSquare(panel, ab, 1));
  await pressTo(page, await centreOf(endSquare(panel, ab, 'head')), sq);
  expect(await labelsOf(panel)).toEqual(['cut here']);
  // off the square onto empty canvas: an ordinary end drag again (a spot whose leg lies on no other wire: there it would
  // be a short circuit, the user's rule 2)
  const tried: Pt[] = [sq];
  const near = [[-36, 0], [-36, 36], [-36, -36]].map(([dx, dy]) => ({ x: sq.x + dx!, y: sq.y + dy! }));
  for (let i = 0; i < 9; i++) {
    const off = near[i] ?? await emptySpot(panel, tried);
    tried.push(off);
    await page.mouse.move(off.x, off.y, { steps: 6 });
    await frames(page);
    if ((await labelsOf(panel))[0] !== 'short circuit') break;
  }
  expect(await labelsOf(panel)).toEqual(['move here']);
  await expect(panel.locator('.design-gone')).toHaveCount(0);
  // back on it, then Escape: nothing changes
  await page.mouse.move(sq.x, sq.y, { steps: 6 });
  await frames(page);
  expect(await labelsOf(panel)).toEqual(['cut here']);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(panel.locator('.design-drop-label')).toHaveCount(0);
  await expect(panel.locator('.design-gone')).toHaveCount(0);
  await expect.poll(() => pointsOf(panel, ab)).toEqual(before);
  expect(await dashOf(panel, ab)).toBe('none');
});

test('cut: an end square released on the wire\'s other end square deletes the whole wire; Ctrl+Z brings it back', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  await pickWire(page, panel, ab);
  await pressTo(page, await centreOf(endSquare(panel, ab, 'head')), await centreOf(endSquare(panel, ab, 'tail')));
  expect(await labelsOf(panel)).toEqual(['delete wire']);
  await expect(edge(panel, ab).locator('g.wire.faded')).toHaveCount(1);
  await page.mouse.up();
  await expect(edge(panel, ab)).toHaveCount(0);
  await expect(page.getByText('● design draft')).toBeVisible();
  await focusCanvas(page, panel);
  await page.keyboard.press('Control+z');
  await expect(edge(panel, ab)).toHaveCount(1);
  expect(await dashOf(panel, ab)).toBe('none');
});

test('cut: a wire joined on the part that goes opens where it is drawn; one joined on the part kept stays joined', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  // b -> c's tail joined low on a -> b's vertical run (past its middle), a new wire's tail joined on its first run
  expect(await dragEnd(page, panel, bc, 'tail', await pointOnWire(panel, ab, 0.8, 12))).toBe('join here');
  const joinedAt = (await pointsOf(panel, bc))[0]!;
  // from a, so its tail moves only a little onto a -> b (a leg drawn across the row would lie on other wires: rule 2)
  const tap = await newWire(page, panel, t.a, await emptySpot(panel));
  expect(await dragEnd(page, panel, tap, 'tail', await pointOnWire(panel, ab, 0.08, 4))).toBe('join here');
  const tapAt = (await pointsOf(panel, tap))[0]!;
  await pickWire(page, panel, ab, 0.4);
  await pressTo(page, await centreOf(endSquare(panel, ab, 'head')), await centreOf(runSquare(panel, ab, 1)));
  expect(await labelsOf(panel)).toEqual(['cut here']);
  await page.mouse.up();
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(0);
  expect((await pointsOf(panel, bc))[0]).toEqual(joinedAt);
  await expect(edge(panel, tap).locator('circle.nx-joint')).toHaveCount(1);
  expect((await pointsOf(panel, tap))[0]).toEqual(tapAt);
});

test('cut is the end square\'s alone: a run square or the body dragged onto the wire\'s own squares never cuts or deletes it', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  await pickWire(page, panel, ab);
  // run 0 (horizontal) dragged down onto run 1's square: the run moves, the wire is whole, its head still on b
  const run1 = await centreOf(runSquare(panel, ab, 1));
  await pressTo(page, await centreOf(runSquare(panel, ab, 0)), run1);
  await expect(panel.locator('.design-drop-label')).toHaveCount(0);
  await expect(panel.locator('.design-gone')).toHaveCount(0);
  await page.mouse.up();
  await expect(edge(panel, ab)).toHaveCount(1);
  const b = await flowBox(panel, t.b);
  expect((await pointsOf(panel, ab)).at(-1)![0]).toBe(b.x);
  expect(await dashOf(panel, ab)).toBe('none');
  // run 1 (vertical) dragged sideways onto the tail square
  await pickWire(page, panel, ab);
  await pressTo(page, await centreOf(runSquare(panel, ab, 1)), await centreOf(endSquare(panel, ab, 'tail')));
  await expect(panel.locator('.design-drop-label')).toHaveCount(0);
  await page.mouse.up();
  await expect(edge(panel, ab)).toHaveCount(1);
  expect((await pointsOf(panel, ab)).at(-1)![0]).toBe(b.x);

  // the body (closed hand) pressed and released over its own head square, then its tail square: it only moves whole
  for (const side of ['head', 'tail'] as const) {
    await pickWire(page, panel, ab);
    const before = await pointsOf(panel, ab);
    const target = await centreOf(endSquare(panel, ab, side));
    const body = await pointOnWire(panel, ab, 0.5);
    await pressTo(page, body, target);
    expect((await labelsOf(panel)).some((l) => l === 'cut here' || l === 'delete wire')).toBe(false);
    await page.mouse.up();
    await expect(edge(panel, ab)).toHaveCount(1);
    const after = await pointsOf(panel, ab);
    expect(after).toHaveLength(before.length);
    shiftOf(before, after);
  }
});

test('cut: an entry wire cut while the hub fans out its tails stays exactly where it was drawn, cut on the grid (review 2026-10-09)', async ({ page }) => {
  const panel = await open(page);
  // a second entry wire, of another net (into d, Failed): the hub's automatic tails now leave 16 above and below its
  // centre, a track apart, off its 15 degree points (one net's would share the centre, plan 10 phase 3)
  await newWire(page, panel, 'wf', await onSide(panel, t.d, 'in'));
  const id = `wf->${t.a}`;
  const before = await pointsOf(panel, id);
  const hub = await flowBox(panel, 'wf');
  expect(before[0]![1]).not.toBe(hub.y + hub.h / 2);
  await pickWire(page, panel, id);
  const run = runSquare(panel, id, 0);
  await pressTo(page, await centreOf(endSquare(panel, id, 'head')), await centreOf(run));
  expect(await labelsOf(panel)).toEqual(['cut here']);
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, id)).not.toEqual(before);
  const after = await pointsOf(panel, id);
  // its tail where it was, its first run on the same line, its open end on the grid
  expect(after[0]).toEqual(before[0]);
  expect(after.at(-1)![1]).toBe(before[0]![1]);
  expect(Math.abs(after.at(-1)![0] % 8)).toBe(0);
  expect(after).toHaveLength(2);
});
