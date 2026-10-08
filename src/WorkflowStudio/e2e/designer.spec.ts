import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { centreOf, documentPanel, expect, inspector, openWorkflow, pointOnWire, settledView, tab, test, workflowsWithSteps, type LiveWorkflow } from './studio';

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

const node = (panel: Locator, id: string) => panel.locator(`.react-flow__node[data-id="${id}"]`);
const wire = (panel: Locator, id: string) => panel.locator(`.react-flow__edge[data-id="${id}"]`);
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
  await expect(inspector(page).getByText(/^Wire: /)).toBeVisible();
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
});

test('a wire end dropped where it closes a loop is allowed: green, "re-attach here", and the loop is drawn (plan 8 §5)', async ({ page }) => {
  const { a, b, c } = chain!;
  test.skip(chain!.wires.has(`${b}->${a}`), 'b -> a is already a wire: the drop would be a duplicate (a loose wire)');
  const panel = await open(page);
  const p = await pointOnWire(panel, `${b}->${c}`);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator('.design-handle.end[data-end="target"]'));
  const target = await centreOf(node(panel, a).locator('.nx-sn'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(node(panel, a)).toHaveClass(/drop-ok/);
  await expect(panel.locator('.design-drop-label')).toHaveText('re-attach here');
  await page.mouse.up();
  await expect(wire(panel, `${b}->${a}`)).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('a new entry wire from the hub, Delete, and a step left unreached looks like any step; Undo and Redo', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  await node(panel, 'wf').hover();
  const port = await centreOf(node(panel, 'wf').locator('.nx-port'));
  const target = await centreOf(node(panel, c).locator('.nx-sn'));
  await drag(page, port, target);
  await expect(wire(panel, `wf->${c}`)).toHaveCount(1);

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

test('the arrow head of a picked wire dropped on an allowed step re-attaches it there', async ({ page }) => {
  test.skip(!chain!.reattachable, 'no chain where a -> c may be drawn');
  const panel = await open(page);
  const { a, b, c } = chain!;
  const p = await pointOnWire(panel, `${a}->${b}`);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${a}->${b}"] .design-handle.end[data-end="target"]`));
  const target = await centreOf(node(panel, c).locator('.nx-sn'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(node(panel, c)).toHaveClass(/drop-ok/);
  await page.mouse.up();
  await expect(wire(panel, `${a}->${c}`)).toHaveCount(1);
  await expect(wire(panel, `${a}->${b}`)).toHaveCount(0);
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

test('a dragged wire end lands on a step\'s border, never inside; on its own step it moves its contact point; on empty canvas it becomes a loose wire', async ({ page }) => {
  const panel = await open(page);
  const { a, b } = chain!;
  const id = `${a}->${b}`;
  const grab = async () => {
    const p = await pointOnWire(panel, id);
    await page.mouse.click(p.x, p.y);
    const head = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="target"]`));
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    return head;
  };
  const before = await pathOf(panel, id);

  // its own step, higher up: the wire stays outside it, and the contact point moves there
  await grab();
  const bb = (await node(panel, b).boundingBox())!;
  await page.mouse.move(bb.x + 6, bb.y + bb.height * 0.3, { steps: 8 });
  await expect(panel.locator('.design-drop-label')).toHaveText('move contact here');
  expect(await blocksCrossed(panel, id)).toEqual([]);
  await page.mouse.up();
  await expect.poll(() => pathOf(panel, id)).not.toBe(before);
  expect(await blocksCrossed(panel, id)).toEqual([]);

  // empty canvas: grey "loose wire"; released, the wire leaves the wiring and stays drawn with an open end
  const head = await grab();
  await page.mouse.move(head.x - 40, head.y + 220, { steps: 8 });
  await expect(panel.locator('.design-drop-label')).toHaveText('loose wire');
  await page.mouse.up();
  await expect(wire(panel, id)).toHaveCount(0);
  await expect(panel.locator('.react-flow__edge[data-id^="loose:"] circle.nx-open')).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('a dragged tail over its own step is told "starts here"; a head 5 px short of a step border is already over it', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  const id = `${a}->${b}`;
  await zoomInOn(page, panel, id);
  let p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const tail = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="source"]`));
  const own = await centreOf(node(panel, a).locator('.nx-sn'));
  await page.mouse.move(tail.x, tail.y);
  await page.mouse.down();
  await page.mouse.move(own.x, own.y, { steps: 8 });
  await expect(panel.locator('.design-drop-label')).toHaveText('starts here');
  await expect(node(panel, a)).toHaveClass(/drop-ok/);
  await page.mouse.up();
  await expect(page.getByText('● design draft')).toHaveCount(0);
  p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="target"]`));
  const cb = (await node(panel, c).boundingBox())!;
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(cb.x - 5, cb.y + cb.height / 2, { steps: 8 });
  if (chain!.reattachable) {
    await expect(node(panel, c)).toHaveClass(/drop-ok/);
    await expect(panel.locator('.design-drop-label')).toHaveText('re-attach here');
  } else {
    // a already goes to c: a second a -> c is a loose-wire drop (plan 8 §5)
    await expect(node(panel, c)).toHaveClass(/drop-loose/);
    await expect(panel.locator('.design-drop-label')).toHaveText('loose wire');
  }
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
const mayJoin = (a: LiveWire, b: LiveWire) => a.id !== b.id && a.colour === b.colour && a.target !== b.target;
const otherColour = (a: LiveWire, b: LiveWire) => a.colour !== b.colour;

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

/** Picks wire `a` and drags its arrow end to a point on `b`'s line clear of every block; the pointer stays down. */
async function dragArrowOnto(page: Page, panel: Locator, a: string, b: string): Promise<void> {
  const p = await pointOnWire(panel, a);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${a}"] .design-handle.end[data-end="target"]`));
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

test('a wire\'s arrow dropped on a same-colour line joins it: a dot on the line, its branch lands on its own step, nothing inside a block; refresh keeps it; undo removes it', async ({ page, request }) => {
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
  await expect(edge.locator('circle.nx-joint').first()).toBeVisible();
  // the contact dot lies on the host's line
  const dot = await centreOf(edge.locator('circle.nx-joint').first());
  const near = await wire(panel, b).locator('path.w').first().evaluate((el, q) => {
    const path = el as SVGPathElement; const m = path.getScreenCTM()!; const len = path.getTotalLength();
    let best = Infinity;
    for (let s = 0; s <= len; s += 1) { const pt = path.getPointAtLength(s); best = Math.min(best, Math.hypot(pt.x * m.a + pt.y * m.c + m.e - q.x, pt.x * m.b + pt.y * m.d + m.f - q.y)); }
    return best;
  }, dot);
  expect(near).toBeLessThan(3);
  // its arrow head lands on its own step's left side
  const target = a.split('->')[1]!;
  const tb = (await node(panel, target).boundingBox())!;
  const tip = await edge.locator('.nx-head').boundingBox();
  expect(tip).not.toBeNull();
  expect(Math.abs(tip!.x + tip!.width - tb.x)).toBeLessThan(6);
  expect(await blocksCrossed(panel, a)).toEqual([]);
  expect(await blocksCrossed(panel, b)).toEqual([]);
  await expect(page.getByText('● design draft')).toBeVisible();
  await page.screenshot({ path: 'test-results/plan7-joined.png' });
  // undo removes it, redo brings it back (one history step); the history is not kept across a refresh (plan 4 spec)
  await panel.locator('.studio-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(edge.locator('circle.nx-joint')).toHaveCount(0);
  await expect(page.getByText('● design draft')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(edge.locator('circle.nx-joint').first()).toBeVisible();
  // a refresh keeps the junction
  await page.reload();
  const again = documentPanel(page, j!.workflow);
  await expect(wire(again, a).locator('circle.nx-joint').first()).toBeVisible();
  expect(await blocksCrossed(again, a)).toEqual([]);
});

test('a wire\'s arrow over a line of another colour is a loose-wire drop: grey halo, "loose wire"; released there the wire becomes loose', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null || !j.wires.some((x) => j.wires.some((y) => otherColour(x, y))), 'no wire of another colour');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a: c, b, between } = (await nearestPair(panel, j!.wires, otherColour))!;
  await zoomInOn(page, panel, between);
  await dragArrowOnto(page, panel, c, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('loose wire');
  await expect(wire(panel, b).locator('.wire.halo-loose')).toHaveCount(1);
  await page.mouse.up();
  await expect(wire(panel, c)).toHaveCount(0);
  await expect(panel.locator('.react-flow__edge[data-id^="loose:"]')).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();
});

test('a joined wire\'s contact square has the four-way move cursor, a plain end square ew-resize; the contact dropped on its own step makes it plain', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null, 'no two same-colour wires into different steps');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a, b, between } = (await nearestPair(panel, j!.wires, mayJoin))!;
  await zoomInOn(page, panel, between);
  // a plain wire's end square: ew-resize under the real pointer
  const p = await pointOnWire(panel, b);
  await page.mouse.click(p.x, p.y);
  const plainEnd = panel.locator(`.design-wire[data-wire="${b}"] .design-handle.end[data-end="target"]`);
  await expect(plainEnd).not.toHaveClass(/contact/);
  let q = await centreOf(plainEnd);
  await page.mouse.move(q.x, q.y);
  expect(await cursorAt(page, q)).toEqual({ cursor: 'ew-resize', cls: expect.stringMatching(/design-handle end/) });
  // join a onto b; a stays picked: its contact square is the four-way move
  await dragArrowOnto(page, panel, a, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('join here');
  await page.mouse.up();
  await expect(wire(panel, a).locator('circle.nx-joint').first()).toBeVisible();
  const contact = panel.locator(`.design-wire[data-wire="${a}"] .design-handle.end.contact[data-end="target"]`);
  await expect(contact).toHaveCount(1);
  q = await centreOf(contact);
  await page.mouse.move(q.x, q.y);
  expect(await cursorAt(page, q)).toEqual({ cursor: 'move', cls: expect.stringMatching(/contact/) });
  // the contact square dropped on its own step: the wire is plain again
  const own = node(panel, a.split('->')[1]!);
  const o = await centreOf(own);
  await page.mouse.down();
  await page.mouse.move(o.x, o.y, { steps: 10 });
  await expect(own).toHaveClass(/drop-ok/);
  await page.mouse.up();
  await expect(wire(panel, a).locator('circle.nx-joint')).toHaveCount(0);
  await expect(wire(panel, a).locator('path.w')).toHaveCount(1);
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

test('a wire\'s arrow dragged over a cache tag is a loose-wire drop: grey "loose wire", the cache outlined grey; released there the wire becomes loose', async ({ page, request }) => {
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
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="target"]`));
  const over = await centreOf(cache);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(over.x, over.y, { steps: 10 });
  await expect(panel.locator('.design-drop-label')).toHaveText('loose wire');
  await expect(cache).toHaveClass(/drop-loose/);
  await page.mouse.up();
  await expect(cache).not.toHaveClass(/drop-/);
  await expect(wire(panel, id!)).toHaveCount(0);
  await expect(panel.locator('.react-flow__edge[data-id^="loose:"]')).toHaveCount(1);
});

test('a new wire dropped on empty canvas is a loose wire: grey, dashed, an open end; a refresh keeps it; its end dropped on a step wires it (plan 8 §5)', async ({ page }) => {
  const { c } = chain!;
  // the open end goes to a step c is not wired to yet (onto one it already goes to, it would stay loose)
  const a = [chain!.a, chain!.b].find((s) => !chain!.wires.has(`${c}->${s}`));
  test.skip(a === undefined, 'c already goes to both a and b: no step to wire its loose end to');
  const panel = await open(page);
  await node(panel, c).hover();
  const port = await centreOf(node(panel, c).locator('.nx-port'));
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  const empty = { x: area.x + area.width - 80, y: area.y + area.height - 120 };
  await drag(page, port, empty);
  const loose = panel.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(loose).toHaveCount(1);
  const line = loose.locator('path.w');
  expect(await line.evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe('none');
  expect(await line.getAttribute('stroke')).toBe('#8A97A8');
  await expect(loose.locator('circle.nx-open')).toHaveCount(1);
  await expect(loose.locator('.nx-head')).toHaveCount(0);

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  const kept = again.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(kept).toHaveCount(1);

  // its open end onto a step it may wire to: an ordinary wire
  const end = await centreOf(kept.locator('.nx-open-hit'));
  const target = await centreOf(node(again, a!).locator('.nx-sn'));
  await page.mouse.move(end.x, end.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await expect(again.locator('.design-drop-label')).toHaveText('connect here');
  await page.mouse.up();
  await expect(wire(again, `${c}->${a!}`)).toHaveCount(1);
  await expect(again.locator('.react-flow__edge[data-id^="loose:"]')).toHaveCount(0);
  // the new wire is the pick: the click React Flow reports after the release does not take it away
  await expect(again.locator(`.design-wire[data-wire="${c}->${a!}"]`)).toHaveCount(1);
  await expect(inspector(page).getByText(/^Wire: /)).toBeVisible();
});

test('a loose wire from the hub: its open end dropped back on the hub is told "same step" and snaps back', async ({ page }) => {
  const panel = await open(page);
  await node(panel, 'wf').hover();
  const port = await centreOf(node(panel, 'wf').locator('.nx-port'));
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  await drag(page, port, { x: area.x + area.width - 80, y: area.y + area.height - 120 });
  const loose = panel.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(loose).toHaveCount(1);
  const before = await loose.locator('path.w').getAttribute('d');

  const end = await centreOf(loose.locator('.nx-open-hit'));
  const hub = await centreOf(node(panel, 'wf'));
  await page.mouse.move(end.x, end.y);
  await page.mouse.down();
  await page.mouse.move(hub.x, hub.y, { steps: 10 });
  await expect(panel.locator('.design-drop-label')).toHaveText('same step');
  await page.mouse.up();
  await expect(panel.locator('.design-drop-label')).toHaveCount(0);
  await expect(loose).toHaveCount(1);
  // a stable read, not one a re-render could still change: an end moved onto the hub changes the path
  await page.waitForTimeout(300);
  await expect.poll(() => loose.locator('path.w').getAttribute('d')).toBe(before);
});

test('the legend shows the loose wire, and nothing broken or parked (plan 8 §5)', async ({ page }) => {
  const panel = await open(page);
  const items = panel.locator('.legend .lg-item');
  await expect(items.filter({ hasText: /^loose wire$/ })).toHaveCount(1);
  await expect(items.filter({ hasText: /broken/i })).toHaveCount(0);
  await expect(items.filter({ hasText: /parked/i })).toHaveCount(0);
});

/** A point on the canvas's empty pane (no block, wire, handle or overlay under it), in page coordinates; null when none is found. */
async function emptySpot(panel: Locator, avoid: { x: number; y: number }[] = []): Promise<{ x: number; y: number } | null> {
  return panel.locator('.react-flow').evaluate((el, far) => {
    const r = el.getBoundingClientRect();
    for (let fy = 0.15; fy < 0.9; fy += 0.07) for (let fx = 0.9; fx > 0.1; fx -= 0.07) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (far.some((p) => Math.hypot(p.x - x, p.y - y) < 120)) continue;
      // clear of everything 40 px around, so the drop reach of no block or line counts
      const clear = [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40]].every(([dx, dy]) => {
        const hit = el.ownerDocument.elementFromPoint(x + dx!, y + dy!);
        return hit !== null && hit.classList.contains('react-flow__pane');
      });
      if (clear) return { x, y };
    }
    return null;
  }, avoid);
}

test('a picked loose wire has the squares of a wire: a run square reshapes it, a refresh keeps the shape, Reset route undoes it; its start square re-sources it or snaps back; its open-end square wires it', async ({ page }) => {
  const { a, c, reattachable } = chain!;
  // re-sourced onto a, its open end then goes to c: a must not already go to c
  test.skip(!reattachable, 'a already goes to c: the open end dropped on c would stay loose');
  const panel = await open(page);
  await node(panel, c).hover();
  const port = await centreOf(node(panel, c).locator('.nx-port'));
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  await drag(page, port, { x: area.x + area.width - 80, y: area.y + area.height - 120 });
  const loose = panel.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(loose).toHaveCount(1);
  const id = (await loose.getAttribute('data-id'))!;
  const squares = panel.locator(`.design-wire[data-wire="${id}"]`);
  const line = () => loose.locator('path.w').getAttribute('d');

  // the new loose wire is the pick: a square on each end and one in the middle of each run, one size on screen
  await expect(squares.locator('.design-handle.end[data-end="source"]')).toHaveCount(1);
  await expect(squares.locator('.design-handle.end[data-end="target"]')).toHaveCount(1);
  const runs = squares.locator('.design-handle.seg');
  expect(await runs.count()).toBeGreaterThan(0);
  const size = (await squares.locator('.design-handle.end[data-end="source"]').boundingBox())!;
  expect(size.width).toBeGreaterThan(7);
  expect(size.width).toBeLessThan(13);

  // a run square moves its run, as a connected wire's does
  const before = await line();
  const handle = runs.first();
  const at = await centreOf(handle);
  const across = /\bh\b/.test((await handle.getAttribute('class')) ?? '');
  await drag(page, at, across ? { x: at.x, y: at.y + 48 } : { x: at.x + 48, y: at.y });
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
  const start = sq.locator('.design-handle.end[data-end="source"]');
  await expect(start).toHaveCount(1);

  // its start square on empty canvas: it snaps back
  const s0 = await centreOf(start);
  const empty = await emptySpot(again, [s0, await centreOf(sq.locator('.design-handle.end[data-end="target"]'))]);
  expect(empty, 'no empty spot on the canvas').not.toBeNull();
  await page.mouse.move(s0.x, s0.y);
  await page.mouse.down();
  await page.mouse.move(empty!.x, empty!.y, { steps: 10 });
  // held there: the wire follows the pointer, and the label says why it may not go there (open at both ends)
  await expect.poll(() => kept.locator('path.w').getAttribute('d')).not.toBe(shaped);
  await expect(again.locator('.design-drop-label')).toHaveText('needs one end');
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect.poll(() => kept.locator('path.w').getAttribute('d')).toBe(shaped);

  // right-click → Reset route: the router draws it again, from the same source to the same end; Ctrl+Z brings the shape back
  const onLine = await pointOnWire(again, id);
  await page.mouse.click(onLine.x, onLine.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset route' }).click();
  await expect.poll(() => kept.locator('path.w').getAttribute('d')).toBe(before);
  await page.keyboard.press('Control+z');
  await expect.poll(() => kept.locator('path.w').getAttribute('d')).toBe(shaped);
  // the undo keeps the pick, or a click picks it again
  if (await start.count() === 0) { const p = await pointOnWire(again, id); await page.mouse.click(p.x, p.y); }
  await expect(start).toHaveCount(1);

  // its start square onto step a: the loose wire now starts at a's output port
  const onA = await centreOf(node(again, a).locator('.nx-sn'));
  await page.mouse.move(s0.x, s0.y);
  await page.mouse.down();
  await page.mouse.move(onA.x, onA.y, { steps: 10 });
  await expect(again.locator('.design-drop-label')).toHaveText('re-attach here');
  await page.mouse.up();
  await expect(kept).toHaveCount(1);
  const aBox = (await node(again, a).boundingBox())!;
  await expect.poll(async () => {
    const p = await centreOf(sq.locator('.design-handle.end[data-end="source"]'));
    return Math.abs(p.x - (aBox.x + aBox.width)) < 8 && p.y > aBox.y && p.y < aBox.y + aBox.height;
  }).toBe(true);

  // its open-end square onto c: an ordinary wire a -> c, the pick
  const end = await centreOf(sq.locator('.design-handle.end[data-end="target"]'));
  const onC = await centreOf(node(again, c).locator('.nx-sn'));
  await page.mouse.move(end.x, end.y);
  await page.mouse.down();
  await page.mouse.move(onC.x, onC.y, { steps: 10 });
  await expect(again.locator('.design-drop-label')).toHaveText('connect here');
  await page.mouse.up();
  await expect(wire(again, `${a}->${c}`)).toHaveCount(1);
  await expect(again.locator('.react-flow__edge[data-id^="loose:"]')).toHaveCount(0);
  await expect(again.locator(`.design-wire[data-wire="${a}->${c}"]`)).toHaveCount(1);
});

// ---- a wire's tail detached: loose at its start, keeping its head and its colour ----

/** Presses `from`, moves to `to` with the real mouse, reads the drop label there, then releases. */
async function dragReading(page: Page, panel: Locator, from: { x: number; y: number }, to: { x: number; y: number }): Promise<string | null> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  const label = panel.locator('.design-drop-label');
  const text = (await label.count()) > 0 ? await label.textContent() : null;
  await page.mouse.up();
  return text;
}

/** Picks a wire by a click on its line and returns its tail square's centre. */
async function tailSquare(page: Page, panel: Locator, id: string): Promise<{ x: number; y: number }> {
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  return centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="source"]`));
}

test('a wire\'s tail released on empty canvas leaves it loose at its start: dashed in its own colour, an open start, its target loses it; a refresh keeps it; its open start onto its step wires it again', async ({ page }) => {
  const { a, b } = chain!;
  const id = `${a}->${b}`;
  const panel = await open(page);
  await zoomInOn(page, panel, id);
  const colour = await wire(panel, id).locator('path.w').first().getAttribute('stroke');
  const tail = await tailSquare(page, panel, id);
  const head = await centreOf(panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="target"]`));
  const empty = await emptySpot(panel, [tail, head]);
  expect(empty, 'no empty spot on the canvas').not.toBeNull();
  expect(await dragReading(page, panel, tail, empty!)).toBe('loose wire');

  await expect(wire(panel, id)).toHaveCount(0);
  const loose = panel.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(loose).toHaveCount(1);
  const line = loose.locator('path.w').first();
  expect(await line.getAttribute('stroke')).toBe(colour);
  expect(await line.evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe('none');
  // its open circle where the tail was released; its arrow head still on b
  const circle = await centreOf(loose.locator('circle.nx-open'));
  expect(Math.hypot(circle.x - empty!.x, circle.y - empty!.y)).toBeLessThan(16);
  await expect(loose.locator('.nx-head')).toHaveCount(1);
  const bb = (await node(panel, b).boundingBox())!;
  const tip = (await loose.locator('.nx-head').boundingBox())!;
  expect(Math.abs(tip.x + tip.width - bb.x)).toBeLessThan(6);
  // picked, it has the squares of a wire
  const lid = (await loose.getAttribute('data-id'))!;
  const squares = panel.locator(`.design-wire[data-wire="${lid}"]`);
  await expect(squares.locator('.design-handle.end')).toHaveCount(2);
  expect(await squares.locator('.design-handle.seg').count()).toBeGreaterThan(0);
  await expect(page.getByText('● design draft')).toBeVisible();
  await panel.screenshot({ path: 'test-results/tail-loose.png' });

  // its head released on nothing would leave it open at both ends: refused, it snaps back
  const before = await line.getAttribute('d');
  const h = await centreOf(squares.locator('.design-handle.end[data-end="target"]'));
  const s = await centreOf(squares.locator('.design-handle.end[data-end="source"]'));
  const nowhere = await emptySpot(panel, [h, s]);
  expect(await dragReading(page, panel, h, nowhere!)).toBe('needs one end');
  await page.waitForTimeout(300);
  await expect.poll(() => line.getAttribute('d')).toBe(before);

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  const kept = again.locator(`.react-flow__edge[data-id="${lid}"]`);
  await expect(kept).toHaveCount(1);
  expect(await kept.locator('path.w').first().getAttribute('stroke')).toBe(colour);
  await expect(wire(again, id)).toHaveCount(0);

  // its open start onto a: an ordinary wire a -> b again, the pick
  const start = await centreOf(kept.locator('.nx-open-hit'));
  const onA = await centreOf(node(again, a).locator('.nx-sn'));
  expect(await dragReading(page, again, start, onA)).toBe('connect here');
  await expect(wire(again, id)).toHaveCount(1);
  await expect(again.locator('.react-flow__edge[data-id^="loose:"]')).toHaveCount(0);
  await expect(again.locator(`.design-wire[data-wire="${id}"]`)).toHaveCount(1);
});

test('an entry wire\'s tail dragged off the hub is loose at its start, its step no longer an entry; a refresh keeps it; dropped back on the hub it is an entry wire again', async ({ page, request }) => {
  const g = (await (await request.get(`/api/v1/workflows/${chain!.workflow.id}/graph`)).json()) as { workflow: { entryStepIds: string[] } };
  const entry = g.workflow.entryStepIds[0];
  test.skip(entry === undefined, 'the workflow has no entry step');
  const id = `wf->${entry!}`;
  const panel = await open(page);
  const colour = await wire(panel, id).locator('path.w').first().getAttribute('stroke');
  const tail = await tailSquare(page, panel, id);
  const empty = await emptySpot(panel, [tail]);
  expect(empty, 'no empty spot on the canvas').not.toBeNull();
  expect(await dragReading(page, panel, tail, empty!)).toBe('loose wire');
  await expect(wire(panel, id)).toHaveCount(0);
  const loose = panel.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(loose).toHaveCount(1);
  expect(await loose.locator('path.w').first().getAttribute('stroke')).toBe(colour);

  await page.reload();
  const again = documentPanel(page, chain!.workflow);
  const kept = again.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(kept).toHaveCount(1);
  await expect(wire(again, id)).toHaveCount(0);

  const start = await centreOf(kept.locator('.nx-open-hit'));
  const hub = await centreOf(node(again, 'wf'));
  expect(await dragReading(page, again, start, hub)).toBe('connect here');
  await expect(wire(again, id)).toHaveCount(1);
  await expect(again.locator('.react-flow__edge[data-id^="loose:"]')).toHaveCount(0);
  // the entry list is the saved one again: nothing left to save
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('a joined wire\'s tail detached keeps its junction and its host\'s colour', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null, 'no two same-colour wires into different steps');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a, b, between } = (await nearestPair(panel, j!.wires, mayJoin))!;
  await zoomInOn(page, panel, between);
  await dragArrowOnto(page, panel, a, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('join here');
  await page.mouse.up();
  await expect(wire(panel, a).locator('circle.nx-joint').first()).toBeVisible();
  const host = await wire(panel, b).locator('path.w').first().getAttribute('stroke');

  // still picked after the join: its tail square off its step, onto empty canvas
  const tail = await centreOf(panel.locator(`.design-wire[data-wire="${a}"] .design-handle.end[data-end="source"]`));
  const empty = await emptySpot(panel, [tail, between]);
  expect(empty, 'no empty spot on the canvas').not.toBeNull();
  expect(await dragReading(page, panel, tail, empty!)).toBe('loose wire');
  await expect(wire(panel, a)).toHaveCount(0);
  const loose = panel.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(loose).toHaveCount(1);
  expect(await loose.locator('path.w').first().getAttribute('stroke')).toBe(host);
  await expect(loose.locator('circle.nx-joint').first()).toBeVisible();
  await expect(loose.locator('circle.nx-open')).toHaveCount(1);
  await panel.screenshot({ path: 'test-results/tail-loose-joined.png' });
  await page.reload();
  const again = documentPanel(page, j!.workflow);
  await expect(again.locator('.react-flow__edge[data-id^="loose:"] circle.nx-joint').first()).toBeVisible();
});

test('a host wire detached at its tail and re-attached to a new source keeps the wires joined on it joined (on its new id)', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null, 'no two same-colour wires into different steps: no junction can be made');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a, b, between } = (await nearestPair(panel, j!.wires, mayJoin))!;
  await zoomInOn(page, panel, between);
  await dragArrowOnto(page, panel, a, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('join here');
  await page.mouse.up();
  await expect(wire(panel, a).locator('circle.nx-joint').first()).toBeVisible();

  // the host b's tail off its step: b is loose at its start, a (joined on b's old id) is drawn plain meanwhile
  const [bSource, bTarget] = b.split('->') as [string, string];
  const tail = await tailSquare(page, panel, b);
  const empty = await emptySpot(panel, [tail, between]);
  expect(empty, 'no empty spot on the canvas').not.toBeNull();
  expect(await dragReading(page, panel, tail, empty!)).toBe('loose wire');
  const loose = panel.locator('.react-flow__edge[data-id^="loose:"]');
  await expect(loose).toHaveCount(1);
  await expect(wire(panel, a).locator('circle.nx-joint')).toHaveCount(0);

  // zoomed out again (Ctrl+wheel at the canvas's middle), so other steps are on screen
  const mid = await centreOf(panel.locator('.studio-canvas'));
  await page.mouse.move(mid.x, mid.y);
  await page.keyboard.down('Control');
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 240);
  await page.keyboard.up('Control');
  await settledView(page, panel.locator('.react-flow__viewport'));
  // a new source for b, on screen: a step that is neither end of b and does not already wire to b's target
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  const steps = [...new Set(j!.wires.flatMap((w) => w.id.split('->')))];
  let source: string | null = null;
  for (const s of steps) {
    if (s === bSource || s === bTarget || j!.wires.some((w) => w.id === `${s}->${bTarget}`)) continue;
    const r = await node(panel, s).boundingBox();
    if (r && r.x > area.x + 20 && r.y > area.y + 40 && r.x + r.width < area.x + area.width - 20 && r.y + r.height < area.y + area.height - 60) { source = s; break; }
  }
  test.skip(source === null, 'no other step on screen that may start b');
  const start = await centreOf(loose.locator('.nx-open-hit'));
  expect(await dragReading(page, panel, start, await centreOf(node(panel, source!).locator('.nx-sn')))).toBe('connect here');
  await expect(wire(panel, `${source!}->${bTarget}`)).toHaveCount(1);
  await expect(loose).toHaveCount(0);
  // a is joined again, on b's new id: its dot lies on the new wire's line
  await expect(wire(panel, a).locator('circle.nx-joint').first()).toBeVisible();
  await page.reload();
  const again = documentPanel(page, j!.workflow);
  await expect(wire(again, a).locator('circle.nx-joint').first()).toBeVisible();
});
