import type { Locator, Page } from '@playwright/test';
import {
  centreOf, documentPanel, dragEnd, dragRunAcross, edge, endSquare, expect, flowToPage, freeWire, labelsOf, layOn, newWire, node, openWorkflow,
  pickWire, pointOnWire, problems, pressTo, shapeByHand, squareOn, test, upright, wirePoints as pointsOf, zoomOf,
} from './studio';
import { createCircuitThrowaway, removeThrowaway, type CircuitThrowaway } from './throwaway';

// The user's rules 1 and 2 (2026-10-09), with the real mouse: a direction-less wire is "just a wire" (grey, dashed,
// gives no colour), and two wires of different nets sharing a stretch of line are a short circuit. The workflow is the
// circuit throwaway (e2e/throwaway.ts, `e2e-9-…`: a, b, c Completed, d Failed; wf -> a, a -> b, a -> d, b -> c). The
// browser only reads (studio.ts's guard): nothing here is saved.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.OVERLAP_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

const TEAL = '#2DD4BF', GREY = '#8A97A8';
const drawn = (panel: Locator, id: string) => edge(panel, id).locator('path.w').first();
const colourOf = (panel: Locator, id: string) => drawn(panel, id).getAttribute('stroke');
const dashOf = (panel: Locator, id: string) => drawn(panel, id).evaluate((el) => getComputedStyle(el).strokeDasharray);
const red = (panel: Locator, id: string) => edge(panel, id).locator('path.nx-overlap');

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

test('rule 1: a direction-less wire joined on a teal wire stays grey and dashed, and a wire joined on it takes no colour from it', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  const f = await freeWire(page, panel, t.c);
  expect(await dragEnd(page, panel, f, 'head', await pointOnWire(panel, ab, 0.5, 12))).toBe('join here');
  await expect(edge(panel, f).locator('circle.nx-joint')).toHaveCount(1);
  // joined on a teal wire, it is still just a wire: grey, dashed, no ring, no arrow head
  expect(await colourOf(panel, f)).toBe(GREY);
  expect(await dashOf(panel, f)).not.toBe('none');
  await expect(edge(panel, f).locator('circle.nx-src')).toHaveCount(0);
  await expect(edge(panel, f).locator('path.nx-head')).toHaveCount(0);
  // a wire from d poured into it: its colour would come only through the direction-less wire, so it has none
  const g = await newWire(page, panel, t.d, await pointOnWire(panel, f, 0.5, 12));
  await expect(edge(panel, g).locator('circle.nx-joint')).toHaveCount(1);
  expect(await colourOf(panel, g)).toBe(GREY);
  expect(await dashOf(panel, g)).not.toBe('none');
  // the host keeps its own colour
  expect(await colourOf(panel, ab)).toBe(TEAL);
  expect(await dashOf(panel, ab)).toBe('none');
  await shot(page, '1-direction-less-grey');
});

test('rule 2: a both-open wire laid on a live wire shaped by hand is a short circuit: both drawn red along the shared stretch, Output pins it; a refresh keeps it', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  // a -> b shaped by hand: its upright run a grid step across (an automatic wire would take a free track around the other)
  await shapeByHand(page, panel, ab);
  const f = await freeWire(page, panel, t.c);
  await expect(red(panel, ab)).toHaveCount(0);
  const shared = await layOn(page, panel, f, ab);
  // both wires red along the stretch they share
  for (const id of [ab, f]) {
    await expect(red(panel, id)).toHaveCount(1);
    expect(await red(panel, id).getAttribute('d')).toBe(`M${shared.x} ${shared.lo} L${shared.x} ${shared.hi}`);
  }
  expect(await colourOf(panel, f)).toBe(GREY);
  const pinned = await problems(page);
  const row = pinned.getByRole('listitem').filter({ hasText: 'overlaps' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(new RegExp(`short circuit: ${t.tag}-a_1\\.0\\.0-\\S+ → ${t.tag}-b_1\\.0\\.0-\\S+ overlaps an open end → an open end`));
  await expect(row.locator('.gate')).toHaveText('Wire');
  await shot(page, '2-both-open-on-live');
  // clicking the row picks both wires on the canvas (review 2026-10-09)
  await row.click();
  await expect(edge(panel, ab).locator('.wire.picked')).toHaveCount(1);
  await expect(edge(panel, f).locator('.wire.picked')).toHaveCount(1);

  // a refresh keeps the drawing and the short circuit
  await page.reload();
  const again = documentPanel(page, t.workflow);
  for (const id of [ab, f]) await expect(red(again, id)).toHaveCount(1);
  await expect((await problems(page)).getByRole('listitem').filter({ hasText: 'overlaps' })).toHaveCount(1);
  await shot(page, '3-after-refresh');
});

test('rule 2: a run square dragged onto another net\'s wire is refused: "short circuit", and the run snaps back', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, ad = `${t.a}->${t.d}`;
  // a -> d's tail slid to the bottom of a's output: it gets an upright run beside a -> b's; then shaped by hand there
  expect(await dragEnd(page, panel, ad, 'tail', await (async () => { const b = (await node(panel, t.a).boundingBox())!; return { x: b.x + b.width * 0.85, y: b.y + b.height * 0.95 }; })())).toBe('connect here');
  const d0 = await upright(panel, ad);
  expect(await dragRunAcross(page, panel, ad, d0, -8)).toEqual([]);
  const d = await upright(panel, ad);
  const b = await upright(panel, ab);
  expect(Math.min(d.hi, b.hi) - Math.max(d.lo, b.lo), 'their upright runs share heights').toBeGreaterThan(8);
  const was = await pointsOf(panel, ab);
  // a -> b's upright run onto a -> d's: a short circuit while it is there, red on both in the preview
  await pickWire(page, panel, ab);
  const from = await squareOn(panel, ab, b);
  const z = await zoomOf(panel);
  await pressTo(page, from, { x: from.x + (d.x - b.x) * z, y: from.y });
  expect(await labelsOf(panel)).toEqual(['short circuit']);
  await expect(panel.locator('.design-drop-label.no')).toHaveCount(1);
  // the wire stays put under its dashed preview (Visio, plan 10 phase 2); the stretch the preview would share with
  // a -> d is drawn red, on a -> d's upright run
  const short = panel.locator('path.design-short');
  await expect(short).toHaveCount(1);
  const xs = [...((await short.getAttribute('d')) ?? '').matchAll(/[ML]([-\d.e]+) /g)].map((m) => Number(m[1]));
  expect(new Set(xs)).toEqual(new Set([d.x]));
  await shot(page, '4-run-square-refused');
  await page.mouse.up();
  await expect(short).toHaveCount(0);
  // released there: it snaps back
  await expect.poll(() => pointsOf(panel, ab)).toEqual(was);
  await expect(red(panel, ad)).toHaveCount(0);
  await expect(red(panel, ab)).toHaveCount(0);
});

test('rule 2: an end square whose drawn leg lies on another net\'s wire is refused: "short circuit", and the end snaps back', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  // a -> b shaped by hand (its upright run a grid step across): it stays where it is
  const b = await shapeByHand(page, panel, ab);
  const was = await pointsOf(panel, bc);
  // b's output to c's input, straight (the 128 px layout gap since plan 10 phase 3)
  expect(was).toEqual([[928, 416], [1056, 416]]);
  expect(b.lo < 240 && b.hi >= 416, 'a -> b comes down past y 240 into b').toBe(true);
  // b -> c's tail drawn up off b's output, over b, then down along a -> b's upright run past where it turns into b
  // (a leg drawn through a step goes around it, spec §4.2, so the leg is drawn clear of b)
  await pickWire(page, panel, bc);
  const tail = await centreOf(endSquare(panel, bc, 'tail'));
  await pressTo(page, tail, await flowToPage(panel, [b.x, b.hi + 48]), [await flowToPage(panel, [928, 240]), await flowToPage(panel, [b.x, 240])]);
  expect(await labelsOf(panel)).toEqual(['short circuit']);
  await shot(page, '5-end-square-refused');
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, bc)).toEqual(was);
});

test('rule 2: a crossing is no short circuit: an end square drawn across a live wire is "move here" and nothing is red', async ({ page }) => {
  const panel = await open(page);
  const bc = `${t.b}->${t.c}`, ab = `${t.a}->${t.b}`;
  // a -> b shaped by hand, so it stays where it is (an automatic wire could step aside)
  const b = await shapeByHand(page, panel, ab);
  const abWas = await pointsOf(panel, ab);
  // b -> c's tail up off b's output, then left across a -> b's upright run
  await pickWire(page, panel, bc);
  const tail = await centreOf(endSquare(panel, bc, 'tail'));
  // (32 short of a -> b's upright: beyond a line's 12 px reach, which would join it)
  await pressTo(page, tail, await flowToPage(panel, [b.x - 32, 240]), await flowToPage(panel, [928, 240]));
  expect(await labelsOf(panel)).toEqual(['move here']);
  await page.mouse.up();
  await expect.poll(() => pointsOf(panel, bc)).toEqual([[1056, 416], [928, 416], [928, 240], [b.x - 32, 240]].reverse());
  // it crosses a -> b, which has not moved
  expect(await pointsOf(panel, ab)).toEqual(abWas);
  expect(b.lo < 240 && b.hi > 240, 'it crosses a -> b').toBe(true);
  await expect(panel.locator('path.nx-overlap')).toHaveCount(0);
  await expect((await problems(page)).getByRole('listitem')).toHaveCount(0);
  await shot(page, '6-crossing');
});

test('rule 2: wires of one net may share a line: a fan-out wire run up its trunk is no short circuit', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, bc = `${t.b}->${t.c}`;
  // b -> c taps a -> b's upright run (fan-out: one net, both Completed)
  const b = await upright(panel, ab);
  const tap = await flowToPage(panel, [b.x, Math.round((b.lo + b.hi) / 2 / 8) * 8]);
  expect(await dragEnd(page, panel, bc, 'tail', tap)).toBe('join here');
  await expect(edge(panel, bc).locator('circle.nx-joint')).toHaveCount(1);
  // its first upright run dragged onto the trunk's line
  const c = await upright(panel, bc);
  expect(await dragRunAcross(page, panel, bc, c, b.x - c.x)).toEqual([]);
  await expect.poll(async () => (await upright(panel, bc)).x).toBe(b.x);
  const now = await upright(panel, bc);
  expect(Math.min(now.hi, b.hi) - Math.max(now.lo, b.lo), 'it lies on the trunk').toBeGreaterThan(0);
  await expect(panel.locator('path.nx-overlap')).toHaveCount(0);
  await expect(edge(panel, bc).locator('circle.nx-joint.short')).toHaveCount(0);
  await expect((await problems(page)).getByRole('listitem')).toHaveCount(0);
  await shot(page, '7-same-net-trunk');
});

test('a wire the router brought into a junction from the line\'s far side keeps that side when a run square shapes it (review 2026-10-09)', async ({ page }) => {
  const panel = await open(page);
  // a wire from d poured into a -> b at its corner (where a -> b turns down, at its stub), reached a jog off its line
  const corner = (await pointsOf(panel, `${t.a}->${t.b}`))[1]!;
  await node(panel, t.d).hover();
  const id = await newWire(page, panel, t.d, await flowToPage(panel, corner));
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
  const before = await pointsOf(panel, id);
  expect(before.at(-1)).toEqual(corner);
  expect(Math.abs(before.at(-2)![1] - corner[1])).toBe(16);
  // its longest upright run dragged a grid step across: shaped by hand now
  const run = await upright(panel, id);
  expect(await dragRunAcross(page, panel, id, run, 8)).toEqual([]);
  await expect.poll(async () => (await upright(panel, id)).x).toBe(run.x + 8);
  const after = await pointsOf(panel, id);
  // still reached from the same side, nothing red
  expect(after.at(-1)).toEqual(corner);
  expect(after.at(-2)).toEqual(before.at(-2));
  await expect(panel.locator('path.nx-overlap')).toHaveCount(0);
});
