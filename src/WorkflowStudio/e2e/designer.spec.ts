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
 * length) that no other wire or block covers. Throws when the whole wire is covered.
 */
async function pointOnWire(panel: Locator, id: string, f = 0.5): Promise<{ x: number; y: number }> {
  const found = await wire(panel, id).locator('path.w').evaluate((el, [at, wid]) => {
    const p = el as SVGPathElement;
    const m = p.getScreenCTM()!;
    const len = p.getTotalLength();
    // every 2 px of the wire (at least 50 samples), nearest `at` first, ends excluded
    const n = Math.max(50, Math.ceil(len / 2));
    const tries = Array.from({ length: n - 1 }, (_, i) => (i + 1) / n).sort((x, y) => Math.abs(x - at) - Math.abs(y - at));
    for (const t of tries) {
      const pt = p.getPointAtLength(len * t);
      const q = { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
      if (el.ownerDocument.elementFromPoint(q.x, q.y)?.closest('.react-flow__edge')?.getAttribute('data-id') === wid) return q;
    }
    return null;
  }, [f, id] as const);
  if (!found) throw new Error(`no point on wire ${id} is uncovered: another wire or a block lies over all of it`);
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
 * does before editing it: at the fitted zoom a short run's square hides under the end dots.
 */
async function zoomInOn(page: Page, panel: Locator, id: string): Promise<void> {
  const p = await pointOnWire(panel, id);
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
    const p = root.querySelector(`.react-flow__edge[data-id="${wid}"] path.w`) as SVGPathElement | null;
    if (!p) return ['<no wire>'];
    const m = p.getScreenCTM()!;
    const len = p.getTotalLength();
    const boxes = [...root.querySelectorAll('.react-flow__node')].map((n) => ({ id: n.getAttribute('data-id')!, r: n.getBoundingClientRect() }));
    const hits = new Set<string>();
    for (let s = 0; s <= len; s += 2) {
      const pt = p.getPointAtLength(s);
      const x = pt.x * m.a + pt.y * m.c + m.e, y = pt.x * m.b + pt.y * m.d + m.f;
      for (const b of boxes) if (x > b.r.left + 6 && x < b.r.right - 6 && y > b.r.top + 6 && y < b.r.bottom - 6) hits.add(b.id);
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
