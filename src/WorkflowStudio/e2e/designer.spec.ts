import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { documentPanel, expect, inspector, openWorkflow, tab, test, workflowsWithSteps, type LiveWorkflow } from './studio';

// Plan 4: the designer is a trial; nothing it does may write (studio.ts's read-only guard checks every
// request). Each test starts from an empty session and works on a live workflow with a chain a -> b -> c
// where b has no other way in.

/** `reattachable`: a -> c may be drawn (a does not already go to c, and c does not reach a). */
interface Chain { workflow: LiveWorkflow; a: string; b: string; c: string; reattachable: boolean }

async function findChain(request: APIRequestContext): Promise<Chain | null> {
  let first: Chain | null = null;
  for (const workflow of await workflowsWithSteps(request)) {
    const g = (await (await request.get(`/api/v1/workflows/${workflow.id}/graph`)).json()) as { workflow: { entryStepIds: string[] }; steps: { id: string; nextStepIds: string[] }[] };
    const next = (id: string) => g.steps.find((s) => s.id === id)?.nextStepIds ?? [];
    const reaches = (from: string, to: string) => {
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (id === to) return true;
        if (!seen.has(id)) { seen.add(id); stack.push(...next(id)); }
      }
      return false;
    };
    const into = (id: string) => g.steps.filter((s) => s.nextStepIds.includes(id)).length + (g.workflow.entryStepIds.includes(id) ? 1 : 0);
    for (const a of g.steps) for (const b of a.nextStepIds) {
      const sb = g.steps.find((s) => s.id === b);
      if (!sb || into(b) !== 1) continue;
      const c = sb.nextStepIds[0];
      if (!c || c === a.id) continue;
      const found = { workflow, a: a.id, b, c, reattachable: !a.nextStepIds.includes(c) && !reaches(c, a.id) };
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

/**
 * A point on a wire, in page coordinates, where that wire is the topmost thing under the pointer: wires
 * into a shared step run together near its input, so this is the point nearest `f` (a fraction of the
 * length) that no other wire or block covers. With `clear`, the point also lies that many screen px outside
 * every block: a block within 8 screen px of the pointer is what a dragged end is over (plan 7 §6.1a), so a
 * line is only the drop target farther out. Throws when no such point exists.
 */
async function pointOnWire(panel: Locator, id: string, f = 0.5, clear = 0): Promise<{ x: number; y: number }> {
  const found = await wire(panel, id).locator('path.w').first().evaluate((el, [at, wid, gap]) => {
    const p = el as SVGPathElement;
    const m = p.getScreenCTM()!;
    const len = p.getTotalLength();
    const boxes = [...(el.closest('.react-flow')?.querySelectorAll('.react-flow__node') ?? [])].map((n) => n.getBoundingClientRect());
    const away = (q: { x: number; y: number }) => boxes.every((r) => q.x < r.left - gap || q.x > r.right + gap || q.y < r.top - gap || q.y > r.bottom + gap);
    // every 2 px of the wire (at least 50 samples), nearest `at` first, ends excluded
    const n = Math.max(50, Math.ceil(len / 2));
    const tries = Array.from({ length: n - 1 }, (_, i) => (i + 1) / n).sort((x, y) => Math.abs(x - at) - Math.abs(y - at));
    for (const t of tries) {
      const pt = p.getPointAtLength(len * t);
      const q = { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
      if (away(q) && el.ownerDocument.elementFromPoint(q.x, q.y)?.closest('.react-flow__edge')?.getAttribute('data-id') === wid) return q;
    }
    return null;
  }, [f, id, clear] as const);
  if (!found) throw new Error(`no point on wire ${id} is uncovered${clear ? ` and ${clear} px clear of every block` : ''}: another wire or a block lies over all of it`);
  return found;
}

async function centreOf(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

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
  const transform = () => panel.locator('.react-flow__viewport').getAttribute('style');
  let last = await transform();
  await expect.poll(async () => { const now = await transform(); const still = now === last; last = now; return still; }, { intervals: [150] }).toBe(true);
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

test('a wire end dropped where it would close a cycle outlines red and snaps back', async ({ page }) => {
  const panel = await open(page);
  const { a, b, c } = chain!;
  const before = await pathOf(panel, `${b}->${c}`);
  const p = await pointOnWire(panel, `${b}->${c}`);
  await page.mouse.click(p.x, p.y);
  const head = await centreOf(panel.locator('.design-handle.end[data-end="target"]'));
  const target = await centreOf(node(panel, a).locator('.nx-sn'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(node(panel, a)).toHaveClass(/drop-no/);
  await page.mouse.up();
  await expect(wire(panel, `${b}->${c}`)).toHaveCount(1);
  expect(await pathOf(panel, `${b}->${c}`)).toBe(before);
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('a new entry wire from the hub, Delete, and a step left unreached is parked; Undo and Redo', async ({ page }) => {
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
  await expect(node(panel, b).getByText('PARKED', { exact: true })).toBeVisible();

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
  await page.getByRole('alertdialog', { name: 'Discard design changes?' }).getByRole('button', { name: 'Cancel' }).click();
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

test('a dragged wire end lands on a step\'s border, never inside; on its own step it moves its contact point; on empty canvas it snaps back', async ({ page }) => {
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

  // empty canvas: snaps back
  const head = await grab();
  await page.mouse.move(head.x - 40, head.y + 220, { steps: 8 });
  expect(await blocksCrossed(panel, id)).toEqual([]);
  await page.mouse.up();
  expect(await pathOf(panel, id)).toBe(before);
  await expect(page.getByText('● design draft')).toHaveCount(0);

  // its own step, higher up: the wire stays outside it, and the contact point moves there
  await grab();
  const bb = (await node(panel, b).boundingBox())!;
  await page.mouse.move(bb.x + 6, bb.y + bb.height * 0.3, { steps: 8 });
  await expect(panel.locator('.design-drop-label')).toHaveText('move contact here');
  expect(await blocksCrossed(panel, id)).toEqual([]);
  await page.mouse.up();
  await expect.poll(() => pathOf(panel, id)).not.toBe(before);
  expect(await blocksCrossed(panel, id)).toEqual([]);
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
    await expect(node(panel, c)).toHaveClass(/drop-no/);
    await expect(panel.locator('.design-drop-label')).toHaveCount(1);
    await expect(panel.locator('.design-drop-label')).toBeVisible();
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

test('a wire\'s arrow over a line of another colour is refused and snaps back', async ({ page, request }) => {
  const j = await findJoin(request);
  test.skip(j === null || !j.wires.some((x) => j.wires.some((y) => otherColour(x, y))), 'no wire of another colour');
  await openWorkflow(page, j!.workflow);
  const panel = documentPanel(page, j!.workflow);
  const { a: c, b, between } = (await nearestPair(panel, j!.wires, otherColour))!;
  await zoomInOn(page, panel, between);
  const before = await pathOf(panel, c);
  await dragArrowOnto(page, panel, c, b);
  await expect(panel.locator('.design-drop-label')).toHaveText('other colour');
  await expect(wire(panel, b).locator('.wire.halo-no')).toHaveCount(1);
  await page.mouse.up();
  expect(await pathOf(panel, c)).toBe(before);
  await expect(wire(panel, c).locator('circle.nx-joint')).toHaveCount(0);
  await expect(page.getByText('● design draft')).toHaveCount(0);
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
