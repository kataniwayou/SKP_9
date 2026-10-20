import type { Locator, Page } from '@playwright/test';
import {
  box, centreOf, documentPanel, edge, emptySpot, expect, flowToPage, inspector, labelsOf, newWire, node, openWorkflow,
  pickWire, pointOnWire, pressTo, runSquare, tab, test, upright, wirePoints, zoomOf,
} from './studio';
import { createCircuitThrowaway, removeThrowaway, type CircuitThrowaway } from './throwaway';

// The findings of the filefetcher_archiveexpander rebuild (2026-10-20) and the user's rulings on them, with the real mouse:
// a Wire tile dropped straight on a contact gets a dragged end's feedback and connects there; a step the Toolbox made
// shows no "no longer exists"; a hand-shaped run laid on another net's automatic wire is refused as "short circuit" (the
// other is never moved aside); junctions keep their place on the drawing when their host is drawn again; Undo survives a
// refresh. The workflow is the circuit throwaway (`e2e-9-…`: wf -> a, a -> b, a -> d (Failed), b -> c); the browser only
// reads (studio.ts's guard), nothing is saved.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.FEEDBACK_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}
const toolbox = (page: Page) => page.locator('[data-pane="toolbox"]');
const tile = (page: Page, tool: string) => toolbox(page).locator(`.tb-tile[data-tool="${tool}"]`).first();
const wireIds = (panel: Locator) => panel.locator('.react-flow__edge').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!));
/** A block's top-left corner in flow coordinates. */
const flowAt = (panel: Locator, id: string) => node(panel, id).evaluate((el) => {
  const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec((el as HTMLElement).style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]) };
});
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));

/** Presses the Wire tile and holds it at flow point `to` (the button stays down); the feedback read there. */
async function holdWireTile(page: Page, panel: Locator, to: readonly [number, number]) {
  const from = await centreOf(tile(page, 'wire'));
  const at = await flowToPage(panel, to);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 5, { steps: 3 });
  await page.mouse.move((from.x + at.x) / 2, (from.y + at.y) / 2, { steps: 6 });
  await page.mouse.move(at.x, at.y, { steps: 8 });
  await frames(page);
  return {
    labels: await labelsOf(panel),
    tones: await panel.locator('.design-drop-label').evaluateAll((els) => els.map((e) => e.getAttribute('class'))),
    lit: await panel.locator('.react-flow__node.drop-ok').evaluateAll((els) => els.map((e) => e.getAttribute('data-id'))),
    halo: await panel.locator('.wire.halo-ok, .wire.halo-no').evaluateAll((els) => els.map((e) => e.closest('.react-flow__edge')!.getAttribute('data-id'))),
    preview: await panel.locator('path.design-tool-wire').count(),
  };
}
/** Releases a held drag and returns the wires it made. */
async function release(page: Page, panel: Locator, before: string[]): Promise<string[]> {
  await page.mouse.up();
  await frames(page);
  return (await wireIds(panel)).filter((id) => !before.includes(id));
}

test('a Wire tile dropped straight on an output, an input, the hub and a line: the feedback of a dragged end, and that end connects there', async ({ page }) => {
  const panel = await open(page);
  const c = await flowAt(panel, t.c), d = await flowAt(panel, t.d);

  // c's output (c feeds nothing): "connect here", c lit, the stub drawn; released, its tail is on c's output
  let before = await wireIds(panel);
  let held = await holdWireTile(page, panel, [c.x + 220, c.y + 96]);
  expect(held.labels).toEqual(['connect here']);
  expect(held.tones).toEqual(['design-drop-label ok']);
  expect(held.lit).toEqual([t.c]);
  expect(held.preview).toBe(1);
  await shot(page, '1-tile-on-output');
  let made = await release(page, panel, before);
  expect(made).toHaveLength(1);
  let pts = await wirePoints(panel, made[0]!);
  expect(pts[0]).toEqual([c.x + 224, c.y + 96]);
  expect(pts.at(-1)).toEqual([c.x + 224 + 96, c.y + 96]);
  await expect(edge(panel, made[0]!).locator('circle.nx-src')).toHaveCount(1);

  // d's input, above the wire a -> d takes at its centre: its head there, arrow drawn, tail open 96 px left
  before = await wireIds(panel);
  held = await holdWireTile(page, panel, [d.x + 4, d.y + 48]);
  expect(held.labels).toEqual(['connect here']);
  expect(held.lit).toEqual([t.d]);
  made = await release(page, panel, before);
  pts = await wirePoints(panel, made[0]!);
  expect(pts.at(-1)).toEqual([d.x, d.y + 48]);
  expect(pts[0]).toEqual([d.x - 96, d.y + 48]);
  await expect(edge(panel, made[0]!).locator('path.nx-head')).toHaveCount(1);

  // the top of the hub's ring: a tail on the workflow
  const hub = await box(node(panel, 'wf'));
  const z = await zoomOf(panel);
  const top = await flowToPage(panel, [0, 0]);
  before = await wireIds(panel);
  held = await holdWireTile(page, panel, [((hub.x + hub.width / 2) - top.x) / z, ((hub.y + 10) - top.y) / z]);
  expect(held.labels).toEqual(['connect here']);
  expect(held.lit).toEqual(['wf']);
  made = await release(page, panel, before);
  await expect(edge(panel, made[0]!).locator('circle.nx-src')).toHaveCount(1);

  // the line b -> c: "join here", the line haloed; released, a junction there
  const on = await pointOnWire(panel, `${t.b}->${t.c}`, 0.5, 12);
  before = await wireIds(panel);
  held = await holdWireTile(page, panel, [(on.x - top.x) / z, (on.y - top.y) / z]);
  expect(held.labels).toEqual(['join here']);
  expect(held.halo).toEqual([`${t.b}->${t.c}`]);
  made = await release(page, panel, before);
  await expect(edge(panel, made[0]!).locator('circle.nx-joint')).toHaveCount(1);
});

test('a Wire tile on a contact where its stub would lie on another wire is "short circuit", red, and drops nothing', async ({ page }) => {
  const panel = await open(page);
  const c = await flowAt(panel, t.c);
  // c's input at its centre: b -> c arrives there, so a stub to the left of it runs back along b -> c
  const before = await wireIds(panel);
  const held = await holdWireTile(page, panel, [c.x + 4, c.y + 96]);
  expect(held.labels).toEqual(['short circuit']);
  expect(held.tones).toEqual(['design-drop-label no']);
  await shot(page, '2-tile-short');
  expect(await release(page, panel, before)).toEqual([]);
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('a step the Toolbox made: the Inspector shows it with no "no longer exists" and no Retry', async ({ page }) => {
  const panel = await open(page);
  const steps = () => panel.locator('.react-flow__node-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!));
  const known = await steps();
  const spot = await emptySpot(panel);
  const from = await centreOf(tile(page, 'step'));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 5, { steps: 3 });
  await page.mouse.move(spot.x, spot.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await steps()).length).toBe(known.length + 1);
  const id = (await steps()).find((x) => !known.includes(x))!;
  await node(panel, id).click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText('STEP');
  await expect(inspector(page).getByLabel('Name', { exact: true })).toHaveValue(/^step/);
  await expect(inspector(page).getByText(/no longer exists/)).toHaveCount(0);
  await expect(inspector(page).getByRole('button', { name: 'Retry' })).toHaveCount(0);
});

test("a run shaped by hand laid on another net's automatic wire is \"short circuit\": it snaps back, and the other wire is not moved aside", async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  // a -> b (automatic) drops on an upright run at x 552 between a and b; a new wire from d's output down to a spot under
  // c has an upright run of its own, in the gap between b and c, over the same heights
  const c = await flowAt(panel, t.c);
  const id = await newWire(page, panel, t.d, await flowToPage(panel, [c.x + 112, c.y + 200]));
  const mine = await upright(panel, id), theirs = await upright(panel, ab);
  expect(Math.min(mine.hi, theirs.hi) - Math.max(mine.lo, theirs.lo)).toBeGreaterThan(64);
  const abBefore = await wirePoints(panel, ab);
  // its upright run dragged across onto a -> b's: refused while held
  await pickWire(page, panel, id);
  const z = await zoomOf(panel);
  const sq = await centreOf(runSquare(panel, id, mine.k));
  await pressTo(page, sq, { x: sq.x + (theirs.x - mine.x) * z, y: sq.y });
  expect(await labelsOf(panel)).toEqual(['short circuit']);
  await shot(page, '3-run-short');
  await page.mouse.up();
  await expect.poll(async () => (await upright(panel, id)).x).toBe(mine.x);
  expect(await wirePoints(panel, ab)).toEqual(abBefore);
});

test('a junction keeps its place on the drawing when its host is drawn again (a block moved): it does not slide along the new line', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  // d's new wire joined on a -> b's upright run: a junction (a fan-in into b)
  const run = await upright(panel, ab);
  const id = await newWire(page, panel, t.d, await flowToPage(panel, [run.x, 256]));
  const joint = () => edge(panel, id).locator('circle.nx-joint').evaluate((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))] as [number, number]);
  await expect(edge(panel, id).locator('circle.nx-joint')).toHaveCount(1);
  const was = await joint();
  // a dragged by its name 64 px down: a -> b is drawn again, starting lower, so the old distance along it points elsewhere
  const name = await centreOf(node(panel, t.a).locator('.nx-sn'));
  const z = await zoomOf(panel);
  const a0 = await flowAt(panel, t.a);
  await page.mouse.move(name.x, name.y);
  await page.mouse.down();
  await page.mouse.move(name.x, name.y + 24 * z, { steps: 4 });
  await page.mouse.move(name.x, name.y + 64 * z, { steps: 8 });
  await page.mouse.up();
  // (an alignment guide may snap it a little short of 64)
  await expect.poll(async () => (await flowAt(panel, t.a)).y).toBeGreaterThanOrEqual(a0.y + 32);
  // the old point still lies on the new line: the junction stays exactly there
  const line = await wirePoints(panel, ab);
  expect(line.some((q, i) => i > 0 && q[0] === was[0] && line[i - 1]![0] === was[0] && Math.min(q[1], line[i - 1]![1]) <= was[1] && Math.max(q[1], line[i - 1]![1]) >= was[1])).toBe(true);
  await expect.poll(joint).toEqual(was);
  await shot(page, '4-junction-kept');
});

test('Undo and Redo survive a refresh: a step nudged, the page reloaded, Ctrl+Z puts it back and Ctrl+Y moves it again', async ({ page }) => {
  const panel = await open(page);
  const b0 = await flowAt(panel, t.b);
  await node(panel, t.b).locator('.nx-sn').click();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await expect.poll(() => flowAt(panel, t.b)).toEqual({ x: b0.x, y: b0.y + 24 });
  // a second gesture, so the history holds two steps
  await page.keyboard.press('ArrowLeft');
  await node(panel, t.c).locator('.nx-sn').click();
  const c0 = await flowAt(panel, t.c);
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(() => flowAt(panel, t.c)).toEqual({ x: c0.x + 16, y: c0.y });

  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(node(again, t.c)).toBeVisible();
  expect(await flowAt(again, t.c)).toEqual({ x: c0.x + 16, y: c0.y });
  await expect(again.getByRole('button', { name: /Undo/ })).toBeEnabled();
  await again.locator('.studio-canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(() => flowAt(again, t.c)).toEqual(c0);
  await page.keyboard.press('Control+z');
  await expect.poll(() => flowAt(again, t.b)).toEqual(b0);
  await expect(page.getByText('● design draft')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect.poll(() => flowAt(again, t.b)).toEqual({ x: b0.x - 8, y: b0.y + 24 });
  await expect(tab(page, t.workflow.name)).toHaveClass(/\bdirty\b/);
  // and a refresh in the middle of the history keeps both ways
  await page.reload();
  const third = documentPanel(page, t.workflow);
  await expect(node(third, t.b)).toBeVisible();
  await expect(third.getByRole('button', { name: /Undo/ })).toBeEnabled();
  await expect(third.getByRole('button', { name: /Redo/ })).toBeEnabled();
});

test('a step may feed itself (free style, the user\'s ruling 2026-10-20): a wire from c\'s output into its own input is "connect here"', async ({ page }) => {
  const panel = await open(page);
  const c = await flowAt(panel, t.c);
  // into c's input above the wire b -> c takes at its centre
  await node(panel, t.c).hover();
  const port = await centreOf(node(panel, t.c).locator('.nx-port'));
  const to = await flowToPage(panel, [c.x + 4, c.y + 40]);
  const before = await wireIds(panel);
  await pressTo(page, port, to);
  expect(await labelsOf(panel)).toEqual(['connect here']);
  await page.mouse.up();
  const made = (await wireIds(panel)).filter((id) => !before.includes(id));
  expect(made).toHaveLength(1);
  const pts = await wirePoints(panel, made[0]!);
  expect(pts[0]).toEqual([c.x + 224, c.y + 96]);
  expect(pts.at(-1)).toEqual([c.x, c.y + 40]);
  await expect(edge(panel, made[0]!).locator('path.nx-head')).toHaveCount(1);
  await expect(panel.locator('path.nx-overlap')).toHaveCount(0);
});
