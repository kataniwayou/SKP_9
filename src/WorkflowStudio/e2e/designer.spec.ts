import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  centreOf, documentPanel, dragReading, dropOpen, edge as wire, emptySpot, endSquare, expect, inspector, node, openWorkflow, pickWire, pointOnWire, pressTo,
  settledView, tab, test, wirePoints,
  workflowsWithSteps, type LiveWorkflow,
} from './studio';

// Plan 4: the designer is a trial; nothing it does may write (studio.ts's read-only guard checks every
// request). Each test starts from an empty session and works on a live workflow with a chain a -> b -> c
// where b has no other way in.

/**
 * `reattachable`: a -> c may be drawn (a does not already go to c; a loop is allowed, plan 8 §5). `wires`: every
 * wire of the live graph (`source->target`), so a test can tell a new wire from a duplicate (a loose-wire drop).
 */
interface Chain { workflow: LiveWorkflow; a: string; b: string; c: string; reattachable: boolean; wires: Set<string> }

async function findChain(request: APIRequestContext): Promise<Chain | null> {
  let first: Chain | null = null;
  for (const workflow of await workflowsWithSteps(request)) {
    const g = (await (await request.get(`/api/v1/workflows/${workflow.id}/graph`)).json()) as { workflow: { entryStepIds: string[] }; steps: { id: string; nextStepIds: string[] }[] };
    const wires = new Set(g.steps.flatMap((s) => s.nextStepIds.map((t) => `${s.id}->${t}`)));
    const into = (id: string) => g.steps.filter((s) => s.nextStepIds.includes(id)).length + (g.workflow.entryStepIds.includes(id) ? 1 : 0);
    for (const a of g.steps) for (const b of a.nextStepIds) {
      const sb = g.steps.find((s) => s.id === b);
      if (!sb || into(b) !== 1) continue;
      const c = sb.nextStepIds[0];
      if (!c || c === a.id) continue;
      const found = { workflow, a: a.id, b, c, reattachable: !a.nextStepIds.includes(c), wires };
      if (found.reattachable) return found;
      first ??= found;
    }
  }
  return first;
}

let chain: Chain | null;
test.beforeAll(async ({ request }) => { chain = await findChain(request); });
test.beforeEach(async ({ page }) => {
  test.skip(chain === null, 'BaseApi has no workflow with a chain a -> b -> c');
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const pathOf = (panel: Locator, id: string) => wire(panel, id).locator('path.w').getAttribute('d');
/** The last point of a wire's path: where its arrow lands. */
const arrowEndOf = async (panel: Locator, id: string) => ((await pathOf(panel, id)) ?? '').match(/-?\d+(?:\.\d+)?/g)?.slice(-2).join(',');

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

/**
 * Zooms in on a wire with Ctrl+wheel at its middle (zoom follows the pointer, spec §5.4), as a person
 * does before editing it: at the fitted zoom a short run's square hides under the end dots. Given a point,
 * zooms in there.
 */
async function zoomInOn(page: Page, panel: Locator, id: string | { x: number; y: number }): Promise<void> {
  const p = typeof id === 'string' ? await pointOnWire(panel, id) : id;
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down('Control');
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');
  await expect.poll(async () => Number((await page.getByRole('status', { name: 'Zoom level' }).first().textContent())?.replace('%', ''))).toBeGreaterThan(70);
  // the wheel zoom eases in: wait until the view stops moving, or a handle's position is read mid-move
  await settledView(page, panel.locator('.react-flow__viewport'));
}

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, chain!.workflow);
  return documentPanel(page, chain!.workflow);
}

test('a moved step takes its wires with it; the draft is marked; a refresh keeps it; Discard drops it', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  const before = await pathOf(panel, `${a}->${b}`);
  const at = await centreOf(node(panel, b).locator('.nx-sn'));
  await drag(page, at, { x: at.x, y: at.y + 120 });
  await expect.poll(() => pathOf(panel, `${a}->${b}`)).not.toBe(before);
  await expect(page.getByText('● design draft')).toBeVisible();
  await expect(tab(page, chain!.workflow.name)).toHaveClass(/\bdirty\b/);

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  await expect(page.getByText('● design draft')).toBeVisible();
  await expect.poll(() => pathOf(again, `${a}->${b}`)).not.toBe(before);

  await page.getByRole('button', { name: 'Discard design' }).click();
  await page.getByRole('alertdialog', { name: 'Discard design' }).getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('● design draft')).toHaveCount(0);
  await expect.poll(() => pathOf(again, `${a}->${b}`)).toBe(before);
});

test('Ctrl+click and a rectangle pick several items; a wire click names the wire', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  await node(panel, a).locator('.nx-sn').click();
  await node(panel, b).locator('.nx-sn').click({ modifiers: ['Control'] });
  await expect(inspector(page).getByText('2 items selected')).toBeVisible();

  const box = (await node(panel, a).boundingBox())!;
  await drag(page, { x: box.x - 12, y: box.y - 12 }, { x: box.x + box.width + 12, y: box.y + box.height + 12 });
  await expect(node(panel, a)).toHaveClass(/studio-pick/);

  const p = await pointOnWire(panel, `${a}->${b}`);
  await page.mouse.click(p.x, p.y);
  await expect(inspector(page).getByLabel('Wire read-out')).toBeVisible();
});

test('a run drags and Reset route restores the automatic shape', async ({ page }) => {
  const panel = await open(page);
  const id = `${chain!.a}->${chain!.b}`;
  const before = await pathOf(panel, id);
  await zoomInOn(page, panel, id);
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const handle = panel.locator('.design-handle.seg').first();
  const at = await centreOf(handle);
  // a horizontal run (class h) moves up and down, a vertical one (v) sideways
  const across = /\bh\b/.test((await handle.getAttribute('class')) ?? '');
  await drag(page, at, across ? { x: at.x, y: at.y + 48 } : { x: at.x + 48, y: at.y });
  await expect.poll(() => pathOf(panel, id)).not.toBe(before);
  const q = await pointOnWire(panel, id, 0.3);
  await page.mouse.click(q.x, q.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset route' }).click();
  await expect.poll(() => pathOf(panel, id)).toBe(before);
  // back to its automatic place: nothing differs from the workflow, so there is no design draft (plan 9)
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

/** A point in a step's left (input) half or right (output) half, in page coordinates (plan 9 decision 5). */
async function inputOf(panel: Locator, id: string): Promise<{ x: number; y: number }> {
  const b = (await node(panel, id).boundingBox())!;
  return { x: b.x + b.width * 0.25, y: b.y + b.height / 2 };
}
async function outputOf(panel: Locator, id: string): Promise<{ x: number; y: number }> {
  const b = (await node(panel, id).boundingBox())!;
  return { x: b.x + b.width * 0.75, y: b.y + b.height / 2 };
}
const dashOf = (l: Locator) => l.locator('path.w').first().evaluate((el) => getComputedStyle(el).strokeDasharray);

test('a wire end dropped where it closes a loop is allowed: green, "connect here", and the wire keeps its id (plan 8 §5, plan 9)', async ({ page }) => {
  const { a, b, c } = chain!;
  const panel = await open(page);
  const id = `${b}->${c}`;
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="head"]`));
  const target = await centreOf(node(panel, a).locator('.nx-sn'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(node(panel, a)).toHaveClass(/drop-ok/);
  await expect(panel.locator('.design-drop-label')).toHaveText('connect here');
  await page.mouse.up();
  await expect(wire(panel, id)).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('a new entry wire from the hub, Delete, and a step left unreached looks like any step; Undo and Redo', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  await node(panel, 'wf').hover();
  const port = await centreOf(node(panel, 'wf').locator('.nx-port'));
  await drag(page, port, await inputOf(panel, c));
  await expect(panel.locator('.react-flow__edge[data-id^="w:"]')).toHaveCount(1);

  const p = await pointOnWire(panel, `${a}->${b}`);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Delete');
  await expect(wire(panel, `${a}->${b}`)).toHaveCount(0);
  await expect(node(panel, b)).toBeVisible();
  await expect(node(panel, b).getByText('PARKED', { exact: true })).toHaveCount(0);
  await expect(node(panel, b).locator('.blk.parked')).toHaveCount(0);

  await page.keyboard.press('Control+z');
  await expect(wire(panel, `${a}->${b}`)).toHaveCount(1);
  await page.getByRole('button', { name: '↷ Redo' }).click();
  await expect(wire(panel, `${a}->${b}`)).toHaveCount(0);
});
test('closing a designed workflow asks; Cancel keeps it', async ({ page }) => {
  const panel = await open(page);
  const at = await centreOf(node(panel, chain!.b).locator('.nx-sn'));
  await drag(page, at, { x: at.x + 64, y: at.y });
  await expect(page.getByText('● design draft')).toBeVisible();
  await tab(page, chain!.workflow.name).getByRole('button', { name: `Close ${chain!.workflow.name}` }).click();
  await page.getByRole('alertdialog', { name: 'Save design changes?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(tab(page, chain!.workflow.name)).toHaveCount(1);
});

test('arrow keys nudge the picked step on the focused canvas; Ctrl+Z puts it back', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  const id = `${a}->${b}`;
  const before = await pathOf(panel, id);
  // the press on the step picks it and gives the canvas focus
  await node(panel, b).locator('.nx-sn').click();
  await expect(panel.locator('.studio-canvas')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => pathOf(panel, id)).not.toBe(before);
  await expect(page.getByText('● design draft')).toBeVisible();
  // the two nudges are one step
  await page.keyboard.press('Control+z');
  await expect.poll(() => pathOf(panel, id)).toBe(before);
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('arrow keys with only a wire picked move it as the closed hand does: whole, detached, grey; Ctrl+Z puts it back (2026-10-10)', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  const id = `${a}->${b}`;
  const before = await pathOf(panel, id);
  const pts = await wirePoints(panel, id);
  await pickWire(page, panel, id);
  await expect(panel.locator('.studio-canvas')).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  // the same shape, 24 px to the left; open at both ends: no arrow head, no source dot, dashed grey
  await expect.poll(() => wirePoints(panel, id)).toEqual(pts.map(([x, y]) => [x - 24, y]));
  const drawn = wire(panel, id).locator('g.wire');
  await expect(drawn).toHaveClass(/dashed/);
  await expect(drawn.locator('.nx-head')).toHaveCount(0);
  await expect(drawn.locator('.nx-src')).toHaveCount(0);
  await expect(page.getByText('● design draft')).toBeVisible();
  // the three presses are one step: one Ctrl+Z puts it back, connected
  await page.keyboard.press('Control+z');
  await expect.poll(() => pathOf(panel, id)).toBe(before);
  await expect(drawn).not.toHaveClass(/dashed/);
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('dragging the last run of a picked wire up and down slides where its arrow lands', async ({ page }) => {
  const panel = await open(page);
  const id = `${chain!.a}->${chain!.b}`;
  await zoomInOn(page, panel, id);
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const before = await arrowEndOf(panel, id);
  const last = panel.locator(`.design-wire[data-wire="${id}"] .design-handle.seg`).last();
  const at = await centreOf(last);
  await drag(page, at, { x: at.x, y: at.y - 24 });
  await expect.poll(() => arrowEndOf(panel, id)).not.toBe(before);
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('the arrow head of a picked wire dropped on another step connects it there; the wire keeps its id (plan 9)', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  const id = `${a}->${b}`;
  const before = await arrowEndOf(panel, id);
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="head"]`));
  const target = await centreOf(node(panel, c).locator('.nx-sn'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(node(panel, c)).toHaveClass(/drop-ok/);
  await page.mouse.up();
  await expect(wire(panel, id)).toHaveCount(1);
  await expect.poll(() => arrowEndOf(panel, id)).not.toBe(before);
  // its arrow head landed on c's input: the tip on c's left side, within its height
  const cb = (await node(panel, c).boundingBox())!;
  const tip = (await wire(panel, id).locator('.nx-head').boundingBox())!;
  expect(Math.abs(tip.x + tip.width - cb.x)).toBeLessThan(6);
  expect(tip.y + tip.height / 2).toBeGreaterThan(cb.y);
  expect(tip.y + tip.height / 2).toBeLessThan(cb.y + cb.height);
  await expect(page.getByText('● design draft')).toBeVisible();
});

/** The blocks a wire passes through on screen (sampled every 2 px; touching a border, 6 px in, does not count). */
async function blocksCrossed(panel: Locator, id: string): Promise<string[]> {
  return panel.evaluate((root, wid) => {
    // every drawn part: a joined wire's own line and its branch (plan 7)
    const parts = [...root.querySelectorAll(`.react-flow__edge[data-id="${wid}"] path.w`)] as SVGPathElement[];
    if (parts.length === 0) return ['<no wire>'];
    const boxes = [...root.querySelectorAll('.react-flow__node')].map((n) => ({ id: n.getAttribute('data-id')!, r: n.getBoundingClientRect() }));
    const hits = new Set<string>();
    for (const p of parts) {
      const m = p.getScreenCTM()!;
      const len = p.getTotalLength();
      for (let s = 0; s <= len; s += 2) {
        const pt = p.getPointAtLength(s);
        const x = pt.x * m.a + pt.y * m.c + m.e, y = pt.x * m.b + pt.y * m.d + m.f;
        for (const b of boxes) if (x > b.r.left + 6 && x < b.r.right - 6 && y > b.r.top + 6 && y < b.r.bottom - 6) hits.add(b.id);
      }
    }
    return [...hits];
  }, id);
}

test('a run dragged onto a block goes around it, while dragged and after the drop', async ({ page }) => {
  test.setTimeout(180_000);
  const panel = await open(page);
  const { a, b, c } = chain!;
  const id = `${a}->${b}`;
  const runs = panel.locator(`.design-wire[data-wire="${id}"] .design-handle.seg`);
  for (const target of [a, b, c, 'wf']) {
    const p = await pointOnWire(panel, id);
    await page.mouse.click(p.x, p.y);
    const n = await runs.count();
    expect(n, 'the picked wire shows run squares').toBeGreaterThan(0);
    // a picked wire shows its end squares and run squares only, never a mark on a bend
    await expect(panel.locator(`.design-wire[data-wire="${id}"] .design-handle:not(.end):not(.seg)`)).toHaveCount(0);
    await expect(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end`)).toHaveCount(2);
    for (let i = 0; i < n; i++) {
      const p2 = await pointOnWire(panel, id);
      await page.mouse.click(p2.x, p2.y);
      const run = runs.nth(i);
      const at = await centreOf(run);
      const to = await centreOf(node(panel, target));
      const across = /\bh\b/.test((await run.getAttribute('class')) ?? '');
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(across ? at.x : to.x, across ? to.y : at.y, { steps: 8 });
      expect(await blocksCrossed(panel, id), `run ${i} dragged onto ${target}`).toEqual([]);
      await page.mouse.up();
      expect(await blocksCrossed(panel, id), `run ${i} dropped onto ${target}`).toEqual([]);
      await page.keyboard.press('Control+z');
    }
  }
});

test('a dragged head lands on a step\'s border, never inside; along its own step it slides; on empty canvas it is open there, dashed, its arrow head kept (plan 9)', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  const id = `${a}->${b}`;
  const grab = async () => {
    const p = await pointOnWire(panel, id);
    await page.mouse.click(p.x, p.y);
    const head = await centreOf(endSquare(panel, id, 'head'));
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    return head;
  };
  const before = await pathOf(panel, id);

  // its own step's input, higher up: the wire stays outside it, and its head slides there
  await grab();
  const bb = (await node(panel, b).boundingBox())!;
  await page.mouse.move(bb.x + 6, bb.y + bb.height * 0.3, { steps: 8 });
  await expect(panel.locator('.design-drop-label')).toHaveText('connect here');
  expect(await blocksCrossed(panel, id)).toEqual([]);
  await page.mouse.up();
  await expect.poll(() => pathOf(panel, id)).not.toBe(before);
  expect(await blocksCrossed(panel, id)).toEqual([]);

  // empty canvas: grey "move here" (a spot whose leg lies on no other wire: rule 2); released, the wire keeps its id,
  // open at its head: dashed, its arrow head kept, no open circle
  await dropOpen(page, panel, async () => {
    const p = await pointOnWire(panel, id);
    await page.mouse.click(p.x, p.y);
    return centreOf(endSquare(panel, id, 'head'));
  });
  await expect(wire(panel, id)).toHaveCount(1);
  expect(await dashOf(wire(panel, id))).not.toBe('none');
  await expect(wire(panel, id).locator('.nx-head')).toHaveCount(1);
  await expect(wire(panel, id).locator('circle.nx-open')).toHaveCount(0);
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('a dragged tail over its own step\'s output is told "connect here" and Escape puts it back; a head 5 px short of a step border is already over it', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  const id = `${a}->${b}`;
  await zoomInOn(page, panel, id);
  let p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const tail = await centreOf(endSquare(panel, id, 'tail'));
  const own = await outputOf(panel, a);
  await page.mouse.move(tail.x, tail.y);
  await page.mouse.down();
  await page.mouse.move(own.x, own.y, { steps: 8 });
  await expect(panel.locator('.design-drop-label')).toHaveText('connect here');
  await expect(node(panel, a)).toHaveClass(/drop-ok/);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByText('● design draft')).toHaveCount(0);
  p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(endSquare(panel, id, 'head'));
  const cb = (await node(panel, c).boundingBox())!;
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(cb.x - 5, cb.y + cb.height / 2, { steps: 8 });
  await expect(node(panel, c)).toHaveClass(/drop-ok/);
  await expect(panel.locator('.design-drop-label')).toHaveText('connect here');
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

interface LiveWire { id: string; target: string; colour: number }

/** A live workflow with two wires whose targets share an entry condition and differ (one may join the other), and all its wires. */
async function findJoin(request: APIRequestContext): Promise<{ workflow: LiveWorkflow; wires: LiveWire[] } | null> {
  for (const workflow of await workflowsWithSteps(request)) {
    const g = (await (await request.get(`/api/v1/workflows/${workflow.id}/graph`)).json()) as { steps: { id: string; nextStepIds: string[]; entryCondition: number }[] };
    const cond = new Map(g.steps.map((s) => [s.id, s.entryCondition]));
    const wires = g.steps.flatMap((s) => s.nextStepIds.filter((t) => cond.has(t)).map((t) => ({ id: `${s.id}->${t}`, target: t, colour: cond.get(t)! })));
    if (wires.some((a) => wires.some((b) => mayJoin(a, b)))) return { workflow, wires };
  }
  return null;
}
/** `a`'s head may go onto `b`'s line: not its own wire, another target, and not one that leads back into `a`'s own step ("same step"). */
const mayJoinAny = (a: LiveWire, b: LiveWire) => a.id !== b.id && a.target !== b.target && b.target !== a.id.split('->')[0];
const mayJoin = (a: LiveWire, b: LiveWire) => mayJoinAny(a, b) && a.colour === b.colour;
const otherColour = (a: LiveWire, b: LiveWire) => mayJoinAny(a, b) && a.colour !== b.colour;

/**
 * Of the pairs (mover, line) that `ok` allows, the one whose mover's arrow (its target's left side) lies
 * nearest the middle of the line on screen, and the point halfway between them: zoomed in there, both the
 * mover's arrow and the line are still in view.
 */
async function nearestPair(panel: Locator, wires: LiveWire[], ok: (a: LiveWire, b: LiveWire) => boolean): Promise<{ a: string; b: string; between: { x: number; y: number } } | null> {
  const heads = new Map<string, { x: number; y: number }>();
  const mids = new Map<string, { x: number; y: number }>();
  for (const w of wires) {
    const t = (await node(panel, w.target).boundingBox())!;
    heads.set(w.id, { x: t.x, y: t.y + t.height / 2 });
    mids.set(w.id, await wire(panel, w.id).locator('path.w').first().evaluate((el) => {
      const p = el as SVGPathElement; const m = p.getScreenCTM()!; const pt = p.getPointAtLength(p.getTotalLength() / 2);
      return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
    }));
  }
  let best: { a: string; b: string; between: { x: number; y: number } } | null = null, d = Infinity;
  for (const a of wires) for (const b of wires) {
    if (!ok(a, b)) continue;
    const h = heads.get(a.id)!, m = mids.get(b.id)!;
    const e = Math.hypot(h.x - m.x, h.y - m.y);
    if (e < d) { d = e; best = { a: a.id, b: b.id, between: { x: (h.x + m.x) / 2, y: (h.y + m.y) / 2 } }; }
  }
  return best;
}

/** Picks wire `a` and drags its head end to a point on `b`'s line clear of every block; the pointer stays down. */
async function dragArrowOnto(page: Page, panel: Locator, a: string, b: string): Promise<void> {
  const p = await pointOnWire(panel, a);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(endSquare(panel, a, 'head'));
  const on = await pointOnWire(panel, b, 0.5, 12);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(on.x, on.y, { steps: 10 });
}

/** The cursor the page shows over a point, and the classes of the element there. */
const cursorAt = (page: Page, q: { x: number; y: number }) => page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y)!;
  return { cursor: getComputedStyle(el).cursor, cls: el.getAttribute('class') ?? '' };
}, q);

/** The distance on screen from a point to a wire's drawn line. */
const gapToLine = (panel: Locator, id: string, q: { x: number; y: number }) => wire(panel, id).locator('path.w').first().evaluate((el, at) => {
  const path = el as SVGPathElement; const m = path.getScreenCTM()!; const len = path.getTotalLength();
  let best = Infinity;
  for (let s = 0; s <= len; s += 1) { const pt = path.getPointAtLength(s); best = Math.min(best, Math.hypot(pt.x * m.a + pt.y * m.c + m.e - at.x, pt.x * m.b + pt.y * m.d + m.f - at.y)); }
  return best;
}, q);

test('a wire\'s head dropped on a same-colour line joins it: a filled circle on the line, no arrow head there, nothing inside a block; undo, redo; a refresh keeps it (plan 9)', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null, 'no two same-colour wires into different steps');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a, b, between } = (await nearestPair(panel, j!.wires, mayJoin))!;
  await zoomInOn(page, panel, between);
  await dragArrowOnto(page, panel, a, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('join here');
  await expect(wire(panel, b).locator('.wire.halo-ok')).toHaveCount(1);
  await page.mouse.up();
  const edge = wire(panel, a);
  await expect(edge.locator('circle.nx-joint')).toHaveCount(1);
  // a head on a junction is a filled circle on the host's line, with no arrow head (rule 4)
  await expect(edge.locator('.nx-head')).toHaveCount(0);
  expect(await gapToLine(panel, b, await centreOf(edge.locator('circle.nx-joint')))).toBeLessThan(3);
  expect(await blocksCrossed(panel, a)).toEqual([]);
  expect(await blocksCrossed(panel, b)).toEqual([]);
  await expect(page.getByText('● design draft')).toBeVisible();
  // undo removes it, redo brings it back (one history step); the history is not kept across a refresh (plan 4 spec)
  await panel.locator('.studio-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(edge.locator('circle.nx-joint')).toHaveCount(0);
  await expect(page.getByText('● design draft')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(edge.locator('circle.nx-joint')).toHaveCount(1);
  // a refresh keeps the junction
  await page.reload();
  const again = documentPanel(page, j!.workflow);
  await expect(wire(again, a).locator('circle.nx-joint')).toHaveCount(1);
  expect(await blocksCrossed(again, a)).toEqual([]);
});

test('a wire\'s head over a line of another colour joins it too: its tail on a step decides nothing, so it takes the host\'s colour (plan 9 rules 7, 10)', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null || !j.wires.some((x) => j.wires.some((y) => otherColour(x, y))), 'no wire of another colour');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a: c, b, between } = (await nearestPair(panel, j!.wires, otherColour))!;
  await zoomInOn(page, panel, between);
  const host = await wire(panel, b).locator('path.w').first().getAttribute('stroke');
  await dragArrowOnto(page, panel, c, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('join here');
  await expect(wire(panel, b).locator('.wire.halo-ok')).toHaveCount(1);
  await page.mouse.up();
  await expect(wire(panel, c)).toHaveCount(1);
  await expect(wire(panel, c).locator('circle.nx-joint')).toHaveCount(1);
  await expect.poll(() => wire(panel, c).locator('path.w').first().getAttribute('stroke')).toBe(host);
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('every end square has the four-way move cursor, a junction\'s too; a junction head dropped on its own step\'s input makes the wire plain (plan 9 rule 14)', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null, 'no two same-colour wires into different steps');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a, b, between } = (await nearestPair(panel, j!.wires, mayJoin))!;
  await zoomInOn(page, panel, between);
  // a plain wire's end squares: the four-way move cursor under the real pointer
  const p = await pointOnWire(panel, b);
  await page.mouse.click(p.x, p.y);
  for (const side of ['tail', 'head'] as const) {
    const q = await centreOf(endSquare(panel, b, side));
    await page.mouse.move(q.x, q.y);
    expect(await cursorAt(page, q)).toEqual({ cursor: 'move', cls: expect.stringMatching(/design-handle end/) });
  }
  // join a onto b; a stays picked: its head square (on the junction) is the four-way move too
  await dragArrowOnto(page, panel, a, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('join here');
  await page.mouse.up();
  await expect(wire(panel, a).locator('circle.nx-joint')).toHaveCount(1);
  const q = await centreOf(endSquare(panel, a, 'head'));
  await page.mouse.move(q.x, q.y);
  expect(await cursorAt(page, q)).toEqual({ cursor: 'move', cls: expect.stringMatching(/design-handle end/) });
  // held, the canvas keeps the four-way cursor; dropped on its own step's input, the wire is plain again
  const own = a.split('->')[1]!;
  const o = await inputOf(panel, own);
  await page.mouse.down();
  await page.mouse.move(o.x, o.y, { steps: 10 });
  await expect(panel.locator('.studio-canvas')).toHaveClass(/gesture-move/);
  await expect(node(panel, own)).toHaveClass(/drop-ok/);
  await page.mouse.up();
  await expect(wire(panel, a).locator('circle.nx-joint')).toHaveCount(0);
  await expect(wire(panel, a).locator('.nx-head')).toHaveCount(1);
});

/** A live workflow with a cache tag on its canvas and at least one step wire, and that workflow's step wires. */
async function findCache(request: APIRequestContext): Promise<{ workflow: LiveWorkflow; wires: string[] } | null> {
  for (const workflow of await workflowsWithSteps(request)) {
    const g = (await (await request.get(`/api/v1/workflows/${workflow.id}/graph`)).json()) as { steps: { id: string; nextStepIds: string[] }[]; caches?: unknown[] };
    const ids = new Set(g.steps.map((s) => s.id));
    const wires = g.steps.flatMap((s) => s.nextStepIds.filter((t) => ids.has(t)).map((t) => `${s.id}->${t}`));
    if ((g.caches?.length ?? 0) > 0 && wires.length > 0) return { workflow, wires };
  }
  return null;
}

test('a wire\'s head dragged over a cache tag is a "move here" drop: the cache outlined grey; released there the head is open, the wire dashed (plan 9 §6)', async ({ page, request }) => {
  const k = await findCache(request);
  test.skip(k === null, 'BaseApi has no workflow with a cache and a step wire');
  await openWorkflow(page, k!.workflow);
  const panel = documentPanel(page, k!.workflow);
  const cache = panel.locator('.react-flow__node[data-id^="cache:"]').first();
  test.skip((await cache.count()) === 0, 'the workflow shows no cache tag on its canvas');
  // the first wire with an uncovered point to pick it by
  let id: string | null = null, p: { x: number; y: number } | null = null;
  for (const w of k!.wires) {
    try { p = await pointOnWire(panel, w); id = w; break; } catch { /* covered: try the next */ }
  }
  test.skip(id === null, 'every step wire is covered by another wire or a block');
  await page.mouse.click(p!.x, p!.y);
  const head = await centreOf(endSquare(panel, id!, 'head'));
  const over = await centreOf(cache);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(over.x, over.y, { steps: 10 });
  await expect(panel.locator('.design-drop-label')).toHaveText('move here');
  await expect(cache).toHaveClass(/drop-move/);
  await page.mouse.up();
  await expect(cache).not.toHaveClass(/drop-/);
  await expect(wire(panel, id!)).toHaveCount(1);
  expect(await dashOf(wire(panel, id!))).not.toBe('none');
  await expect(wire(panel, id!).locator('.nx-head')).toHaveCount(1);
});

test('a new wire dropped on empty canvas is grey and dashed with a ring and an arrow head; a refresh keeps it; its head dropped on a step connects it, coloured and solid (plan 9 rules 3, 12)', async ({ page }) => {
  const { a, c } = chain!;
  const panel = await open(page);
  await node(panel, c).hover();
  const port = await centreOf(node(panel, c).locator('.nx-port'));
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  const empty = { x: area.x + area.width - 80, y: area.y + area.height - 120 };
  await drag(page, port, empty);
  const drawn = panel.locator('.react-flow__edge[data-id^="w:"]');
  await expect(drawn).toHaveCount(1);
  const id = (await drawn.getAttribute('data-id'))!;
  expect(await dashOf(drawn)).not.toBe('none');
  expect(await drawn.locator('path.w').getAttribute('stroke')).toBe('#8A97A8');
  await expect(drawn.locator('circle.nx-src')).toHaveCount(1);
  await expect(drawn.locator('.nx-head')).toHaveCount(1);
  await expect(drawn.locator('circle.nx-open')).toHaveCount(0);

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  const kept = again.locator(`.react-flow__edge[data-id="${id}"]`);
  await expect(kept).toHaveCount(1);

  // picked, its head square onto a's input: connected, the wire keeps its id, a's colour, solid
  const on = await pointOnWire(again, id);
  await page.mouse.click(on.x, on.y);
  const end = await centreOf(endSquare(again, id, 'head'));
  expect(await dragReading(page, again, end, await inputOf(again, a))).toBe('connect here');
  await expect(kept).toHaveCount(1);
  await expect.poll(() => kept.locator('path.w').getAttribute('stroke')).not.toBe('#8A97A8');
  expect(await dashOf(kept)).toBe('none');
  // the wire stays the pick: the click React Flow reports after the release does not take it away
  await expect(again.locator(`.design-wire[data-wire="${id}"]`)).toHaveCount(1);
  await expect(inspector(page).getByLabel('Wire read-out')).toBeVisible();
});

test('a new wire from the hub: its head dropped back on the hub is told "only a tail on the workflow" and snaps back', async ({ page }) => {
  const panel = await open(page);
  await node(panel, 'wf').hover();
  const port = await centreOf(node(panel, 'wf').locator('.nx-port'));
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  await drag(page, port, { x: area.x + area.width - 80, y: area.y + area.height - 120 });
  const drawn = panel.locator('.react-flow__edge[data-id^="w:"]');
  await expect(drawn).toHaveCount(1);
  const id = (await drawn.getAttribute('data-id'))!;
  const before = await drawn.locator('path.w').getAttribute('d');

  // the new wire is the pick: its head square onto the hub
  const end = await centreOf(endSquare(panel, id, 'head'));
  const hub = await centreOf(node(panel, 'wf'));
  await page.mouse.move(end.x, end.y);
  await page.mouse.down();
  await page.mouse.move(hub.x, hub.y, { steps: 10 });
  await expect(panel.locator('.design-drop-label')).toHaveText('only a tail on the workflow');
  await expect(node(panel, 'wf')).toHaveClass(/drop-no/);
  await page.mouse.up();
  await expect(panel.locator('.design-drop-label')).toHaveCount(0);
  await expect(drawn).toHaveCount(1);
  // a stable read, not one a re-render could still change: an end moved onto the hub changes the path
  await page.waitForTimeout(300);
  await expect.poll(() => drawn.locator('path.w').getAttribute('d')).toBe(before);
});

test('the legend shows the undecided wire and the short circuit; no loose wire, nothing broken or parked (plan 9 §5)', async ({ page }) => {
  const panel = await open(page);
  const items = panel.locator('.legend .lg-item');
  await expect(items.filter({ hasText: /^undecided$/ })).toHaveCount(1);
  await expect(items.filter({ hasText: /^short circuit$/ })).toHaveCount(1);
  await expect(items.filter({ hasText: /loose|broken|parked/i })).toHaveCount(0);
});

/** Picks a wire by a click on its line and returns its tail square's centre. */
async function tailSquare(page: Page, panel: Locator, id: string): Promise<{ x: number; y: number }> {
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  return centreOf(endSquare(panel, id, 'tail'));
}

test('a picked new wire has squares on its ends and runs: a run square reshapes it, a refresh keeps the shape, Reset route undoes it; its tail square moves it open or onto a step; its head square connects it', async ({ page }) => {
  const { a, c } = chain!;
  const panel = await open(page);
  await node(panel, c).hover();
  const port = await centreOf(node(panel, c).locator('.nx-port'));
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  await drag(page, port, { x: area.x + area.width - 80, y: area.y + area.height - 120 });
  const drawn = panel.locator('.react-flow__edge[data-id^="w:"]');
  await expect(drawn).toHaveCount(1);
  const id = (await drawn.getAttribute('data-id'))!;
  const squares = panel.locator(`.design-wire[data-wire="${id}"]`);
  const line = () => drawn.locator('path.w').getAttribute('d');

  // the new wire is the pick: a square on each end and one in the middle of each run, one size on screen
  await expect(squares.locator('.design-handle.end[data-end="tail"]')).toHaveCount(1);
  await expect(squares.locator('.design-handle.end[data-end="head"]')).toHaveCount(1);
  const runs = squares.locator('.design-handle.seg');
  expect(await runs.count()).toBeGreaterThan(0);
  const size = (await squares.locator('.design-handle.end[data-end="tail"]').boundingBox())!;
  expect(size.width).toBeGreaterThan(7);
  expect(size.width).toBeLessThan(13);

  // a run square moves its run
  const before = await line();
  const handle = runs.first();
  const at = await centreOf(handle);
  const across = /\bh\b/.test((await handle.getAttribute('class')) ?? '');
  // where the run would lie on another wire the drag is a short circuit and snaps back (rule 2): then the other way
  for (const by of [48, -48, 96, -96]) {
    await drag(page, at, across ? { x: at.x, y: at.y + by } : { x: at.x + by, y: at.y });
    if ((await line()) !== before) break;
  }
  await expect.poll(line).not.toBe(before);
  const shaped = await line();
  await expect(page.getByText('● design draft')).toBeVisible();

  // a refresh keeps the shape
  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  const kept = again.locator(`.react-flow__edge[data-id="${id}"]`);
  await expect(kept).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect.poll(() => kept.locator('path.w').getAttribute('d')).toBe(shaped);

  // picked again by a click on its line
  const on = await pointOnWire(again, id);
  await page.mouse.click(on.x, on.y);
  const sq = again.locator(`.design-wire[data-wire="${id}"]`);
  const start = sq.locator('.design-handle.end[data-end="tail"]');
  await expect(start).toHaveCount(1);

  // its tail square over empty canvas: "move here" (released, the wire would be open at both ends); Escape puts it back
  const s0 = await centreOf(start);
  const empty = await emptySpot(again, [s0, await centreOf(sq.locator('.design-handle.end[data-end="head"]'))]);
  expect(empty, 'no empty spot on the canvas').not.toBeNull();
  await page.mouse.move(s0.x, s0.y);
  await page.mouse.down();
  await page.mouse.move(empty!.x, empty!.y, { steps: 10 });
  await expect.poll(() => kept.locator('path.w').getAttribute('d')).not.toBe(shaped);
  await expect(again.locator('.design-drop-label')).toHaveText('move here');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect.poll(() => kept.locator('path.w').getAttribute('d')).toBe(shaped);

  // right-click → Reset route: the router draws it again; Ctrl+Z brings the shape back
  const onLine = await pointOnWire(again, id);
  await page.mouse.click(onLine.x, onLine.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset route' }).click();
  await expect.poll(() => kept.locator('path.w').getAttribute('d')).toBe(before);
  await page.keyboard.press('Control+z');
  await expect.poll(() => kept.locator('path.w').getAttribute('d')).toBe(shaped);
  // the undo keeps the pick, or a click picks it again
  if (await start.count() === 0) { const p = await pointOnWire(again, id); await page.mouse.click(p.x, p.y); }
  await expect(start).toHaveCount(1);

  // its tail square onto a's output: the wire now starts at a's right side
  const s1 = await centreOf(start);
  expect(await dragReading(page, again, s1, await outputOf(again, a))).toBe('connect here');
  await expect(kept).toHaveCount(1);
  const aBox = (await node(again, a).boundingBox())!;
  await expect.poll(async () => {
    const p = await centreOf(sq.locator('.design-handle.end[data-end="tail"]'));
    return Math.abs(p.x - (aBox.x + aBox.width)) < 8 && p.y > aBox.y && p.y < aBox.y + aBox.height;
  }).toBe(true);

  // its head square onto c's input: connected, the same wire, still the pick
  const end = await centreOf(sq.locator('.design-handle.end[data-end="head"]'));
  expect(await dragReading(page, again, end, await inputOf(again, c))).toBe('connect here');
  await expect(kept).toHaveCount(1);
  expect(await dashOf(kept)).toBe('none');
  await expect(again.locator(`.design-wire[data-wire="${id}"]`)).toHaveCount(1);
});

// ---- a wire's ends moved open: the wire keeps its id, its marks, and the family its other end decides ----

test('a wire\'s tail released on empty canvas leaves it open there: dashed in its own colour, its ring where it was released, its arrow head on its step; a refresh keeps it; its tail onto its step connects it again', async ({ page }) => {
  const { a, b } = chain!;
  const id = `${a}->${b}`;
  const panel = await open(page);
  await zoomInOn(page, panel, id);
  const colour = await wire(panel, id).locator('path.w').first().getAttribute('stroke');
  const tail = await tailSquare(page, panel, id);
  const head = await centreOf(endSquare(panel, id, 'head'));
  const empty = await emptySpot(panel, [tail, head]);
  expect(empty, 'no empty spot on the canvas').not.toBeNull();
  expect(await dragReading(page, panel, tail, empty!)).toBe('move here');

  const edge = wire(panel, id);
  await expect(edge).toHaveCount(1);
  expect(await edge.locator('path.w').first().getAttribute('stroke')).toBe(colour);
  expect(await dashOf(edge)).not.toBe('none');
  // its ring where the tail was released; its arrow head still on b
  const ring = await centreOf(edge.locator('circle.nx-src'));
  expect(Math.hypot(ring.x - empty!.x, ring.y - empty!.y)).toBeLessThan(16);
  await expect(edge.locator('.nx-head')).toHaveCount(1);
  const bb = (await node(panel, b).boundingBox())!;
  const tip = (await edge.locator('.nx-head').boundingBox())!;
  expect(Math.abs(tip.x + tip.width - bb.x)).toBeLessThan(6);
  // still picked, with the squares of a wire
  await expect(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end`)).toHaveCount(2);
  await expect(page.getByText('● design draft')).toBeVisible();

  // its head over nothing is told "move here" (released, it would be open at both ends); Escape puts it back
  const before = await edge.locator('path.w').first().getAttribute('d');
  const h = await centreOf(endSquare(panel, id, 'head'));
  const s = await centreOf(endSquare(panel, id, 'tail'));
  const nowhere = await emptySpot(panel, [h, s]);
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(nowhere!.x, nowhere!.y, { steps: 10 });
  await expect(panel.locator('.design-drop-label')).toHaveText('move here');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect.poll(() => edge.locator('path.w').first().getAttribute('d')).toBe(before);

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  const kept = wire(again, id);
  await expect(kept).toHaveCount(1);
  expect(await kept.locator('path.w').first().getAttribute('stroke')).toBe(colour);
  expect(await dashOf(kept)).not.toBe('none');

  // its tail onto a's output: connected again, solid
  const start = await tailSquare(page, again, id);
  expect(await dragReading(page, again, start, await outputOf(again, a))).toBe('connect here');
  await expect(kept).toHaveCount(1);
  expect(await dashOf(kept)).toBe('none');
  await expect(again.locator(`.design-wire[data-wire="${id}"]`)).toHaveCount(1);
});

test('an entry wire\'s tail dragged off the hub is open there, its step no longer an entry; a refresh keeps it; dropped back on the hub it is an entry wire again', async ({ page, request }) => {
  const g = (await (await request.get(`/api/v1/workflows/${chain!.workflow.id}/graph`)).json()) as { workflow: { entryStepIds: string[] } };
  const entry = g.workflow.entryStepIds[0];
  test.skip(entry === undefined, 'the workflow has no entry step');
  const id = `wf->${entry!}`;
  const panel = await open(page);
  const colour = await wire(panel, id).locator('path.w').first().getAttribute('stroke');
  await dropOpen(page, panel, () => tailSquare(page, panel, id));
  await expect(wire(panel, id)).toHaveCount(1);
  expect(await wire(panel, id).locator('path.w').first().getAttribute('stroke')).toBe(colour);
  expect(await dashOf(wire(panel, id))).not.toBe('none');

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  await expect(wire(again, id)).toHaveCount(1);
  expect(await dashOf(wire(again, id))).not.toBe('none');

  const start = await tailSquare(page, again, id);
  // a point inside the ring above its centre, whatever the zoom (the hub node is the ring's square); the pointer goes
  // across above the hub first, then down onto it, so the leg it draws lies on no other wire (rule 2)
  const hub = (await node(again, 'wf').boundingBox())!;
  const onHub = { x: hub.x + hub.width / 2, y: hub.y + hub.height / 4 };
  await pressTo(page, start, onHub, { x: onHub.x, y: Math.min(start.y, hub.y - 40) });
  await expect(again.locator('.design-drop-label')).toHaveText('connect here');
  await page.mouse.up();
  await expect(wire(again, id)).toHaveCount(1);
  expect(await dashOf(wire(again, id))).toBe('none');
});

test('a joined wire\'s tail moved open keeps its junction; with no end on a step it has no direction: grey (the user\'s rule 1), no ring, no arrow head (rule D)', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null, 'no two same-colour wires into different steps');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a, b, between } = (await nearestPair(panel, j!.wires, mayJoin))!;
  await zoomInOn(page, panel, between);
  await dragArrowOnto(page, panel, a, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('join here');
  await page.mouse.up();
  await expect(wire(panel, a).locator('circle.nx-joint')).toHaveCount(1);
  const host = await wire(panel, b).locator('path.w').first().getAttribute('stroke');

  // still picked after the join: its tail square off its step, onto empty canvas
  const tail = await centreOf(endSquare(panel, a, 'tail'));
  const empty = await emptySpot(panel, [tail, between]);
  expect(empty, 'no empty spot on the canvas').not.toBeNull();
  expect(await dragReading(page, panel, tail, empty!)).toBe('move here');
  const edge = wire(panel, a);
  await expect(edge).toHaveCount(1);
  // direction-less, it takes no colour from its host (the user's rule 1, 2026-10-09)
  expect(host).not.toBe('#8A97A8');
  expect(await edge.locator('path.w').first().getAttribute('stroke')).toBe('#8A97A8');
  await expect(edge.locator('circle.nx-joint')).toHaveCount(1);
  // joined on a line and open: direction-less (the user's rule D, 2026-10-09)
  await expect(edge.locator('circle.nx-src')).toHaveCount(0);
  await expect(edge.locator('.nx-head')).toHaveCount(0);
  expect(await dashOf(edge)).not.toBe('none');
  await page.reload();
  const again = documentPanel(page, j!.workflow);
  await expect(wire(again, a).locator('circle.nx-joint')).toHaveCount(1);
});

test('a host wire detached at its tail opens the end joined on it where it was drawn (spec §2.2-6); the host keeps its id and connects again', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null, 'no two same-colour wires into different steps: no junction can be made');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a, b, between } = (await nearestPair(panel, j!.wires, mayJoin))!;
  await zoomInOn(page, panel, between);
  await dragArrowOnto(page, panel, a, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('join here');
  await page.mouse.up();
  await expect(wire(panel, a).locator('circle.nx-joint')).toHaveCount(1);
  const dot = await centreOf(wire(panel, a).locator('circle.nx-joint'));

  // the host b's tail off its step: a's head opens where it was drawn, with its arrow head
  const bSource = b.split('->')[0]!;
  const tail = await tailSquare(page, panel, b);
  const empty = await emptySpot(panel, [tail, between]);
  expect(empty, 'no empty spot on the canvas').not.toBeNull();
  expect(await dragReading(page, panel, tail, empty!)).toBe('move here');
  await expect(wire(panel, b)).toHaveCount(1);
  await expect(wire(panel, a).locator('circle.nx-joint')).toHaveCount(0);
  await expect(wire(panel, a).locator('.nx-head')).toHaveCount(1);
  const tip = (await wire(panel, a).locator('.nx-head').boundingBox())!;
  expect(Math.hypot(tip.x + tip.width - dot.x, tip.y + tip.height / 2 - dot.y)).toBeLessThan(12);

  // b's tail back onto its step: b connects again (the same wire); a stays open
  const start = await tailSquare(page, panel, b);
  expect(await dragReading(page, panel, start, await outputOf(panel, bSource))).toBe('connect here');
  await expect(wire(panel, b)).toHaveCount(1);
  expect(await dashOf(wire(panel, b))).toBe('none');
  await expect(wire(panel, a).locator('circle.nx-joint')).toHaveCount(0);
});

test('a wire moved open at its tail and then its head is open at both ends: grey, dashed, direction-less (no ring, no arrow head, rule D); a refresh keeps it; each end dropped on a step connects it again, coloured', async ({ page }) => {
  const { a, b } = chain!;
  const id = `${a}->${b}`;
  const panel = await open(page);
  await zoomInOn(page, panel, id);
  const colour = await wire(panel, id).locator('path.w').first().getAttribute('stroke');
  const tail = await tailSquare(page, panel, id);
  const head0 = await centreOf(endSquare(panel, id, 'head'));
  const spot1 = await emptySpot(panel, [tail, head0]);
  expect(spot1, 'no empty spot on the canvas').not.toBeNull();
  expect(await dragReading(page, panel, tail, spot1!)).toBe('move here');

  // its head too, onto nothing: open at both ends
  const head = await centreOf(endSquare(panel, id, 'head'));
  const spot2 = await emptySpot(panel, [spot1!, head]);
  expect(spot2, 'no second empty spot on the canvas').not.toBeNull();
  expect(await dragReading(page, panel, head, spot2!)).toBe('move here');
  const edge = wire(panel, id);
  const line = edge.locator('path.w').first();
  await expect.poll(() => line.getAttribute('stroke')).toBe('#8A97A8');
  expect(await dashOf(edge)).not.toBe('none');
  await expect(edge.locator('circle.nx-src')).toHaveCount(0);
  await expect(edge.locator('.nx-head')).toHaveCount(0);
  await expect(edge.locator('circle.nx-open')).toHaveCount(0);
  await expect(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end`)).toHaveCount(2);

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  const kept = wire(again, id);
  await expect(kept).toHaveCount(1);
  expect(await kept.locator('path.w').first().getAttribute('stroke')).toBe('#8A97A8');
  await expect(kept.locator('circle.nx-src')).toHaveCount(0);
  await expect(kept.locator('.nx-head')).toHaveCount(0);

  // its head onto b's input: b's colour, still dashed (its tail is open)
  const p = await pointOnWire(again, id);
  await page.mouse.click(p.x, p.y);
  const end = await centreOf(endSquare(again, id, 'head'));
  expect(await dragReading(page, again, end, await inputOf(again, b))).toBe('connect here');
  await expect.poll(() => kept.locator('path.w').first().getAttribute('stroke')).toBe(colour);
  expect(await dashOf(kept)).not.toBe('none');
  // a head on a step: it has a direction again, its ring and its arrow head back
  await expect(kept.locator('circle.nx-src')).toHaveCount(1);
  await expect(kept.locator('.nx-head')).toHaveCount(1);
  // its tail onto a's output: the wire a -> b connected again, solid
  const start = await centreOf(endSquare(again, id, 'tail'));
  expect(await dragReading(page, again, start, await outputOf(again, a))).toBe('connect here');
  expect(await dashOf(kept)).toBe('none');
  expect(await kept.locator('path.w').first().getAttribute('stroke')).toBe(colour);
});
