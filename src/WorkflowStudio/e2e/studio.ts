import { expect, test as base, type APIRequestContext, type Locator, type Page } from '@playwright/test';

export { expect };

/** Escapes a name for use inside a RegExp (workflow names are live data). */
export const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The page test with a read-only guard: every request the browser context makes (the main window
 * and any pop-out) is recorded, and the test fails if any request is not a GET (opening a workflow
 * runs no validate, plan 8 §3.1).
 */
export const test = base.extend<{ readOnly: void }>({
  readOnly: [async ({ context }, use) => {
    const writes: string[] = [];
    context.on('request', (r) => {
      if (r.method() === 'GET' || r.method() === 'HEAD') return;
      writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await use();
    expect(writes, 'the e2e tests must only read from BaseApi').toEqual([]);
  }, { auto: true }],
});


export interface LiveWorkflow { id: string; name: string; version: string; label: string }

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The entity-name rule (model/entityNames.ts), so a test can find a workflow in the picker. */
const label = (name: string, version: string, id: string) => `${name}_${version}-${GUID.test(id) ? id.slice(19).toLowerCase() : id}`;

const TOOL_NAMES = new Set(['Toolbox', 'Inspector', 'Problems', 'Output']);

/**
 * Every workflow with a step, each with a distinct name that is not a tool window's. Read-only. Skips
 * workflows named `e2e-…`: those are another spec's throwaway entities (e2e/throwaway.ts), which it edits.
 */
export async function workflowsWithSteps(request: APIRequestContext): Promise<LiveWorkflow[]> {
  const list = await request.get('/api/v1/workflows');
  expect(list.ok()).toBe(true);
  const found: LiveWorkflow[] = [];
  const names = new Set<string>(TOOL_NAMES);
  for (const w of (await list.json()) as { id: string; name: string; version: string }[]) {
    if (names.has(w.name) || w.name.startsWith('e2e-')) continue;
    const graph = await request.get(`/api/v1/workflows/${w.id}/graph`);
    if (graph.ok() && ((await graph.json()) as { steps?: unknown[] }).steps?.length) {
      names.add(w.name);
      found.push({ id: w.id, name: w.name, version: w.version, label: label(w.name, w.version, w.id) });
    }
  }
  return found;
}

/** `count` workflows with distinct names (and none named like a tool window) that have a step. Read-only. */
export async function liveWorkflows(request: APIRequestContext, count: number): Promise<LiveWorkflow[]> {
  const found = await workflowsWithSteps(request);
  if (found.length < count) throw new Error(`BaseApi has fewer than ${count} workflows with steps and distinct names`);
  return found.slice(0, count);
}

/** File › Open workflow…, search by unique name, Enter; waits until the canvas has drawn. */
export async function openWorkflow(page: Page, workflow: LiveWorkflow): Promise<void> {
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Open workflow/ }).click();
  await page.getByRole('textbox', { name: 'Search workflows' }).fill(workflow.label);
  // on a cold dev server the list can still be loading: Enter on an empty list opens nothing
  await expect(page.getByRole('listbox', { name: 'Workflows' }).getByText(workflow.label, { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(documentPanel(page, workflow).locator('.react-flow__node').first()).toBeVisible();
}

/** A tab by the text it shows (a document's name, or a pane's title). */
export const tab = (page: Page, name: string): Locator => page.locator('.dv-tab .doctab').filter({ has: page.locator('.nm', { hasText: new RegExp(`^${esc(name)}$`) }) });

/** A document's panel, found by the unique name its toolbar carries. */
export const documentPanel = (page: Page, workflow: LiveWorkflow): Locator =>
  page.locator('.docpanel').filter({ has: page.locator(`.crumb[data-tip="${workflow.label.replace(/["\\]/g, '\\$&')}"]`) });

/** The Inspector's body wherever it is (docked, floating or in the flyout). */
export const inspector = (page: Page): Locator => page.locator('[data-pane="inspector"]');

/** The group (dockview's `.dv-groupview`) that holds a tab. */
export const groupOf = (page: Page, name: string): Locator => page.locator('.dv-groupview').filter({ has: tab(page, name) });

export async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not laid out');
  return b;
}

/** Moves a floating group (dockview positions it with inline left/top) so it covers `target`'s centre. */
export async function floatOver(floating: Locator, target: { x: number; y: number; width: number; height: number }): Promise<void> {
  const f = await box(floating);
  const dx = target.x + target.width / 2 - (f.x + f.width / 2);
  const dy = target.y + target.height / 2 - (f.y + f.height / 2);
  await floating.evaluate((el, [x, y]) => {
    const e = el as HTMLElement;
    e.style.left = `${parseFloat(e.style.left) + x!}px`;
    e.style.top = `${parseFloat(e.style.top) + y!}px`;
  }, [dx, dy]);
}

/** The rectangle two boxes share, or null. */
export function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width), t = Math.min(a.y + a.height, b.y + b.height);
  return r > x && t > y ? { x, y, width: r - x, height: t - y } : null;
}

/**
 * Selects a processor chip whose Inspector shows the three schema slots. Returns false when no chip
 * of the open document qualifies, so a test can skip with a reason instead of failing confusingly.
 */
export async function selectProcessor(page: Page, panel: Locator): Promise<boolean> {
  const chips = panel.locator('.react-flow__node-step .chipg');
  const n = Math.min(await chips.count(), 8);
  for (let i = 0; i < n; i++) {
    await chips.nth(i).click();
    if ((await inspector(page).locator('.kindpill').textContent()) === 'PROCESSOR' && (await inspector(page).locator('.slot').count()) === 3) return true;
  }
  return false;
}

/**
 * Waits until a canvas's view stops moving (a wheel zoom eases in; a resized canvas keeps its centre) and
 * returns its transform: re-read every 150 ms until two reads in a row match, at most 20 tries.
 */
export async function settledView(page: Page, viewport: Locator): Promise<string | null> {
  let last = await viewport.getAttribute('style');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const now = await viewport.getAttribute('style');
    if (now === last) return now;
    last = now;
  }
  throw new Error('the view did not settle: its transform still changed after 20 reads 150 ms apart');
}

/**
 * A point on a wire, in page coordinates, where that wire is the topmost thing under the pointer: wires
 * into a shared step run together near its input, so this is the point nearest `f` (a fraction of the
 * length) that no other wire or block covers. With `clear`, the point also lies that many screen px outside
 * every block: a block within 8 screen px of the pointer is what a dragged end is over (plan 7 §6.1a), so a
 * line is only the drop target farther out. Throws when no such point exists.
 */
export async function pointOnWire(panel: Locator, id: string, f = 0.5, clear = 0): Promise<{ x: number; y: number }> {
  const found = await panel.locator(`.react-flow__edge[data-id="${id}"]`).locator('path.w').first().evaluate((el, [at, wid, gap]) => {
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

export async function centreOf(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// ---- the designer's wires, with the real mouse (plan 9; shared by every spec that drags a wire) ----

export type Pt = { x: number; y: number };

/** A block on a document's canvas (a step id, `wf` for the hub, `cache:{id}`). */
export const node = (panel: Locator, id: string): Locator => panel.locator(`.react-flow__node[data-id="${id}"]`);
/** A wire as React Flow draws it. */
export const edge = (panel: Locator, id: string): Locator => panel.locator(`.react-flow__edge[data-id="${id}"]`);
/** A picked wire's square on its tail or head. */
export const endSquare = (panel: Locator, id: string, side: 'tail' | 'head'): Locator =>
  panel.locator(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="${side}"]`);
/** Wires drawn in the designer (`w:{guid}`). */
export const newWires = (panel: Locator): Locator => panel.locator('.react-flow__edge[data-id^="w:"]');

/** A point on the canvas's empty pane, nothing within 40 px, at least 120 px from every point of `avoid`. Throws when none is found. */
export async function emptySpot(panel: Locator, avoid: Pt[] = []): Promise<Pt> {
  const found = await panel.locator('.react-flow').evaluate((el, far) => {
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
  if (!found) throw new Error('no empty spot on the canvas');
  return found;
}

/**
 * Presses `from`, moves to `to` with the real mouse, waits for the drop label to show there and for the page to
 * draw two frames (so the label is the one for `to`, not for a point on the way), reads it, then releases.
 */
export async function dragReading(page: Page, panel: Locator, from: Pt, to: Pt): Promise<string | null> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  const label = panel.locator('.design-drop-label');
  await expect(label).toBeVisible();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
  const text = await label.textContent();
  await page.mouse.up();
  return text;
}

/** Picks a wire with a click on its line; its end squares show. */
export async function pickWire(page: Page, panel: Locator, id: string, f = 0.5): Promise<void> {
  const p = await pointOnWire(panel, id, f);
  await page.mouse.click(p.x, p.y);
  await expect(endSquare(panel, id, 'head')).toBeVisible();
}

/** Picks wire `id` and drags its `side` end square to `to` with the real mouse: the drop label read there. */
export async function dragEnd(page: Page, panel: Locator, id: string, side: 'tail' | 'head', to: Pt): Promise<string | null> {
  await pickWire(page, panel, id);
  return dragReading(page, panel, await centreOf(endSquare(panel, id, side)), to);
}

/** Draws a new wire from block `from`'s connection point (a step, or `wf`) to `to`; its id (`w:…`). */
export async function newWire(page: Page, panel: Locator, from: string, to: Pt): Promise<string> {
  const before = await newWires(panel).count();
  await node(panel, from).hover();
  await dragReading(page, panel, await centreOf(node(panel, from).locator('.nx-port')), to);
  await expect(newWires(panel)).toHaveCount(before + 1);
  return (await newWires(panel).last().getAttribute('data-id'))!;
}

// ---- BaseApi reads and the Save/Inspector steps shared by the specs ----

/** A GET on BaseApi through the test runner (never the browser), expected to succeed. */
export async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const r = await request.get(`/api/v1/${path}`);
  expect(r.ok(), `GET ${path}`).toBe(true);
  return (await r.json()) as T;
}

/** The capsule's Save, then wait for the answer (the button leaves "Saving…"). */
export async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: '⤓ Save' }).click();
  await expect(page.getByRole('button', { name: '⤓ Saving…' })).toHaveCount(0, { timeout: 20_000 });
}

/** Opens a tool pane by its tab and returns its body. */
export async function pane(page: Page, name: 'Problems' | 'Output'): Promise<Locator> {
  await tab(page, name).click();
  return page.locator(`[data-pane="${name.toLowerCase()}"]`);
}

/** Picks step `id` and chooses an entry condition in the Inspector, with the real mouse. */
export async function setEntryCondition(page: Page, panel: Locator, id: string, name: RegExp): Promise<void> {
  await node(panel, id).click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText('STEP');
  await inspector(page).getByLabel('Entry condition', { exact: true }).click();
  await inspector(page).getByRole('option', { name }).click();
}
