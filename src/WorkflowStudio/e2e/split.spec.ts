import type { Locator, Page } from '@playwright/test';
import { box, centreOf, documentPanel, emptySpot, endsOnPage, expect, labelsOf, newWires, node, openWorkflow, pointOnWire, test, wirePoints, zoomOf, type Pt } from './studio';
import { createCircuitThrowaway, removeThrowaway, type CircuitThrowaway } from './throwaway';

// Plan 10 phase 5 (Visio is the authority, §4.6): an empty step dropped on a wire splits it, with the real mouse. Visio's
// held look (`shots/ui-stencil-shape-over-wire-held.png`): the wire's two ends as filled green squares. Released, the old
// wire runs into the step and a new one from the step to the old head; one Undo step. Refused on a direction-less wire.
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

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
const tileOf = (page: Page, tool: string) => page.locator(`[data-pane="toolbox"] .tb-tile[data-tool="${tool}"]`);
const stepIds = (panel: Locator) => panel.locator('.react-flow__node-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!));
const squares = (panel: Locator, tone: 'ok' | 'no') => panel.locator(`.design-split-end.${tone}`);
const near = (a: Pt, b: Pt, d = 3) => Math.hypot(a.x - b.x, a.y - b.y) <= d;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  for (let i = 0; i < 2; i++) await panel.getByRole('button', { name: 'Zoom out' }).click();
  await frames(page);
  return panel;
}

/** Presses a Toolbox tile and moves the real mouse to `to`, holding it there. */
async function holdTile(page: Page, tool: string, to: Pt): Promise<void> {
  const tile = tileOf(page, tool);
  await tile.scrollIntoViewIfNeeded();
  const from = await centreOf(tile);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 5, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await frames(page);
}

/** The held squares sit on the wire's two drawn ends. */
async function onEnds(panel: Locator, tone: 'ok' | 'no', wire: string): Promise<void> {
  await expect(squares(panel, tone)).toHaveCount(2);
  const [tail, head] = await endsOnPage(panel, wire);
  const at = await Promise.all((await squares(panel, tone).all()).map(centreOf));
  expect(near(at[0]!, tail) && near(at[1]!, head), JSON.stringify({ at, tail, head })).toBe(true);
}

test('a Toolbox step held over b -> c: its ends green, "insert here"; released, b -> step -> c; one Undo puts it back', async ({ page }) => {
  const panel = await open(page);
  const before = await stepIds(panel);
  const wire = `${t.b}->${t.c}`;
  const whole = await wirePoints(panel, wire);
  await holdTile(page, 'step', await pointOnWire(panel, wire));
  await onEnds(panel, 'ok', wire);
  expect(await labelsOf(panel)).toContain('insert here');
  await expect(panel.locator('.design-tool-landing')).toHaveCount(1);
  await panel.screenshot({ path: 'test-results/split-toolbox-held.png' });
  await page.mouse.up();
  await frames(page);
  await expect(squares(panel, 'ok')).toHaveCount(0);
  await expect.poll(async () => (await stepIds(panel)).length).toBe(before.length + 1);
  const made = (await stepIds(panel)).find((id) => !before.includes(id))!;
  const at = await box(node(panel, made));
  // b -> c now ends on the new step's input; a new wire runs from its output into c
  const z = await zoomOf(panel);
  const into = await wirePoints(panel, wire);
  const flowLeft = (await node(panel, made).evaluate((e) => Number(/translate\(([-\d.e]+)px/.exec((e as HTMLElement).style.transform)![1])));
  expect(into.at(-1)![0]).toBe(flowLeft);
  await expect(newWires(panel)).toHaveCount(1);
  const out = await newWires(panel).first().getAttribute('data-id');
  const outPts = await wirePoints(panel, out!);
  expect(outPts[0]![0]).toBeCloseTo(flowLeft + at.width / z, 0);
  expect(outPts.at(-1)).toEqual(whole.at(-1));
  await panel.screenshot({ path: 'test-results/split-toolbox-done.png' });
  await panel.getByRole('button', { name: /Undo/ }).click();
  await frames(page);
  expect(await stepIds(panel)).toEqual(before);
  await expect(newWires(panel)).toHaveCount(0);
  expect(await wirePoints(panel, wire)).toEqual(whole);
});

test('an empty step on the canvas dragged onto a -> b: held marked, released split; one Undo leaves the step where it was', async ({ page }) => {
  const panel = await open(page);
  const before = await stepIds(panel);
  // an empty step dropped on empty canvas first
  await holdTile(page, 'step', await emptySpot(panel));
  await page.mouse.up();
  await expect.poll(async () => (await stepIds(panel)).length).toBe(before.length + 1);
  const made = (await stepIds(panel)).find((id) => !before.includes(id))!;
  const wire = `${t.a}->${t.b}`;
  const whole = await wirePoints(panel, wire);
  const placed = await box(node(panel, made));
  // pressed on its name, carried onto the wire's run
  const from = await centreOf(node(panel, made).locator('.nx-sn'));
  const target = await pointOnWire(panel, wire);
  const grab = { x: from.x - (placed.x + placed.width / 2), y: from.y - (placed.y + placed.height / 2) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
  await page.mouse.move(target.x + grab.x, target.y + grab.y, { steps: 16 });
  await frames(page);
  await onEnds(panel, 'ok', wire);
  expect(await labelsOf(panel)).toContain('insert here');
  await expect(node(panel, `copy:${made}`)).toHaveCount(1);
  await panel.screenshot({ path: 'test-results/split-canvas-held.png' });
  await page.mouse.up();
  await frames(page);
  await expect(squares(panel, 'ok')).toHaveCount(0);
  const flowLeft = await node(panel, made).evaluate((e) => Number(/translate\(([-\d.e]+)px/.exec((e as HTMLElement).style.transform)![1]));
  expect((await wirePoints(panel, wire)).at(-1)![0]).toBe(flowLeft);
  await expect(newWires(panel)).toHaveCount(1);
  expect((await wirePoints(panel, (await newWires(panel).first().getAttribute('data-id'))!)).at(-1)).toEqual(whole.at(-1));
  // one Undo: the wire whole again, the step back where it was dropped
  await panel.getByRole('button', { name: /Undo/ }).click();
  await frames(page);
  await expect(newWires(panel)).toHaveCount(0);
  expect(await wirePoints(panel, wire)).toEqual(whole);
  expect(await box(node(panel, made))).toEqual(placed);
});

test('a wire with a junction on it splits too (2026-10-22): the joined wire stays on a half, where it was', async ({ page }) => {
  const panel = await open(page);
  const wire = `${t.a}->${t.b}`;
  // a Wire tile's tip on a -> b's line a fifth of the way along: a new wire joined there
  const join = await pointOnWire(panel, wire, 0.2);
  await holdTile(page, 'wire', { x: join.x - 46, y: join.y });
  expect(await labelsOf(panel)).toContain('join here');
  await page.mouse.up();
  await expect(newWires(panel)).toHaveCount(1);
  const branch = (await newWires(panel).first().getAttribute('data-id'))!;
  const [, head] = await endsOnPage(panel, branch);
  // an empty step on the line's middle, past the junction
  await holdTile(page, 'step', await pointOnWire(panel, wire, 0.6));
  await onEnds(panel, 'ok', wire);
  expect(await labelsOf(panel)).toContain('insert here');
  await page.mouse.up();
  await frames(page);
  await expect(newWires(panel)).toHaveCount(2);
  await panel.screenshot({ path: 'test-results/split-junction-done.png' });
  // the branch's head is still on a line of the two halves, near where it was joined
  const halves = await newWires(panel).evaluateAll((els, b) => els.map((e) => e.getAttribute('data-id')!).filter((id) => id !== b), branch);
  const [, now] = await endsOnPage(panel, branch);
  const onLine = async (id: string) => panel.locator(`.react-flow__edge[data-id="${id}"] path.w`).first().evaluate((el, q) => {
    const p = el as SVGPathElement, m = p.getScreenCTM()!, len = p.getTotalLength();
    let best = Infinity;
    for (let d = 0; d <= len; d += 1) { const s = p.getPointAtLength(d); best = Math.min(best, Math.hypot(s.x * m.a + s.y * m.c + m.e - q.x, s.x * m.b + s.y * m.d + m.f - q.y)); }
    return best;
  }, now);
  const gaps = await Promise.all([wire, ...halves].map(onLine));
  expect(Math.min(...gaps), JSON.stringify(gaps)).toBeLessThan(2);
  expect(Math.hypot(now.x - head.x, now.y - head.y)).toBeLessThan(40);
});

test('a direction-less wire refuses a split: its ends red, the refusal said; released, nothing is dropped', async ({ page }) => {
  const panel = await open(page);
  // a free wire from the Wire tile on empty canvas
  await holdTile(page, 'wire', await emptySpot(panel));
  await page.mouse.up();
  await expect(newWires(panel)).toHaveCount(1);
  const free = (await newWires(panel).first().getAttribute('data-id'))!;
  const before = await stepIds(panel);
  await holdTile(page, 'step', await pointOnWire(panel, free));
  await onEnds(panel, 'no', free);
  expect(await labelsOf(panel)).toContain('wire has no direction');
  await panel.screenshot({ path: 'test-results/split-refused-held.png' });
  await page.mouse.up();
  await frames(page);
  expect(await stepIds(panel)).toEqual(before);
  await expect(squares(panel, 'no')).toHaveCount(0);
});
