import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { regionCorner, type Pt } from './seed';

export const PROC_A = 'archive-expander';
export const PROC_B = 'sk-normalizer';

/** Plays an HTML5 drag from `source` onto the page point (x, y) with the app's own payload. */
export async function dragOnto(page: Page, source: Locator, x: number, y: number) {
  const handle = await source.elementHandle();
  await page.evaluate(({ el, x, y }) => {
    const dt = new DataTransfer();
    const fire = (target: Element, type: string) =>
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    fire(el as Element, 'dragstart');
    const over = document.elementFromPoint(x, y)!;
    fire(over, 'dragenter');
    fire(over, 'dragover');
    fire(over, 'drop');
    fire(el as Element, 'dragend');
  }, { el: handle, x, y });
}

// ---- Output --------------------------------------------------------------------------------------------------------

export const out = (page: Page) => page.locator('[data-panel="output"]');
/** An Output line with exactly this text (or matching this pattern). */
export const outLine = (page: Page, text: string | RegExp) =>
  out(page).locator('[role="listitem"] span').filter({ hasText: typeof text === 'string' ? new RegExp(`^${escapeRe(text)}$`) : text });
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const clearOutput = (page: Page) => out(page).getByRole('button', { name: 'Clear all' }).click();

// ---- Opening the board ---------------------------------------------------------------------------------------------

export const LOADED = /Board loaded: \d+ workflows?/;

/** The board after a load: every row in, the viewport laid out. */
export async function waitLoaded(page: Page) {
  await expect(outLine(page, LOADED).first()).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await page.waitForTimeout(250);
}

/**
 * Opens the board with the view on the throwaway region (see seed.ts): flow point `at` (from the region's corner) sits 70 px
 * from the board's top-left, at `zoom`. The view is set once per tab, so a reload keeps the one the app remembered.
 */
export async function openAt(page: Page, at: Pt = { x: 0, y: 0 }, zoom = 1) {
  const c = regionCorner();
  const view = { x: 70 - (c.x + at.x) * zoom, y: 70 - (c.y + at.y) * zoom, zoom, selection: null };
  await page.addInitScript((v) => {
    try {
      if (!sessionStorage.getItem('e2e.view')) { localStorage.setItem('acto.view', JSON.stringify(v)); sessionStorage.setItem('e2e.view', '1'); }
    } catch { /* no storage */ }
  }, view);
  await page.goto('/');
  await waitLoaded(page);
}

/** Opens the board the way a new visitor sees it: fitted to everything. */
export async function openFitted(page: Page) {
  await page.goto('/');
  await waitLoaded(page);
  await expect.poll(() => page.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform))
    .not.toBe('translate(0px, 0px) scale(1)');
  await page.waitForTimeout(400);
}

export const zoomOf = (page: Page) => page.evaluate(() =>
  Number(/scale\(([\d.]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)?.[1] ?? 1));

// ---- Locators ------------------------------------------------------------------------------------------------------

export const wfNode = (page: Page, id: string) => page.locator(`.react-flow__node-workflow[data-id="wf:${id}"]`);
export const stNode = (page: Page, id: string) => page.locator(`.react-flow__node-step[data-id="st:${id}"]`);
export const caNode = (page: Page, id: string) => page.locator(`.react-flow__node-cache[data-id="ca:${id}"]`);
export const entryEdge = (page: Page, wf: string, step: string) => page.locator(`.react-flow__edge[data-id="entry:${wf}:${step}"]`);
export const cacheEdge = (page: Page, wf: string, cache: string) => page.locator(`.react-flow__edge[data-id="cache:${wf}:${cache}"]`);
export const wireEdge = (page: Page, from: string, to: string) => page.locator(`.react-flow__edge[data-id="wire:${from}:${to}"]`);
export const allWorkflows = (page: Page) => page.locator('.react-flow__node-workflow');
export const allSteps = (page: Page) => page.locator('.react-flow__node-step');
export const allCaches = (page: Page) => page.locator('.react-flow__node-cache');

export const toolbar = (page: Page, kind: 'workflow' | 'step' | 'wire' | 'cache' | 'entry' | 'cacheLink') => page.getByRole('toolbar', { name: `${kind} actions` });
export const selbar = (page: Page) => page.getByRole('toolbar', { name: 'selection actions' });
export const inspector = (page: Page) => page.locator('[data-panel="inspector"]');
export const field = (page: Page, label: string | RegExp) =>
  inspector(page).locator('label.fld', { has: page.locator('span', { hasText: typeof label === 'string' ? new RegExp(`^${escapeRe(label)}$`) : label }) }).locator('input, textarea, select, button[role=combobox]');
export const saveButton = (page: Page) => page.locator('button.save-board');
export const workflowTool = (page: Page) => page.getByRole('button', { name: /Workflow\s*drop on the board/ });
export const cacheTool = (page: Page) => page.getByRole('button', { name: /Cache\s*drop on the board/ });
export const toolboxStep = (page: Page, processor: string) =>
  page.getByTestId('toolbox-step').filter({ has: page.locator('.tx', { hasText: new RegExp(`^${escapeRe(processor)}`) }) }).first();

export async function centre(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// ---- Picking -------------------------------------------------------------------------------------------------------

/** Clicks a triangle on its name. */
export const pickWorkflow = (page: Page, id: string) => wfNode(page, id).locator('.tri-nm').click();
/** Clicks a step card on its name line, with Ctrl when `add`. */
export const pickStep = (page: Page, id: string, add = false) => stNode(page, id).locator('.sn').click(add ? { modifiers: ['Control'] } : {});
export const pickCache = (page: Page, id: string, add = false) => caNode(page, id).locator('.cache-nm').click(add ? { modifiers: ['Control'] } : {});

/** Clicks an edge on the middle of its curve (its wide hit path), with Ctrl when `add`. */
export async function pickEdge(page: Page, edge: Locator, add = false) {
  const p = await edge.locator('path.wire-hit, path.edge-hit').first().evaluate((el) => {
    const path = el as SVGPathElement;
    const pt = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  });
  if (add) await page.keyboard.down('Control');
  await page.mouse.click(p.x, p.y);
  if (add) await page.keyboard.up('Control');
}

/** A click on empty board: a point whose topmost element is the pane. */
export async function clickEmptyBoard(page: Page) {
  const p = await page.evaluate(() => {
    const board = document.querySelector('.react-flow__pane')!.getBoundingClientRect();
    for (let y = board.bottom - 40; y > board.top + 40; y -= 20) for (let x = board.left + 300; x < board.right - 260; x += 20) {
      const el = document.elementFromPoint(x, y);
      if (el?.classList.contains('react-flow__pane')) return { x, y };
    }
    return null;
  });
  expect(p, 'an empty spot on the board').not.toBeNull();
  await page.mouse.click(p!.x, p!.y);
}

// ---- Real mouse gestures -------------------------------------------------------------------------------------------

/** A real mouse drag from a handle onto the middle of `to` (or a page point). The hover grows the handle: aim where it is drawn once hovered. */
export async function dragFromHandle(page: Page, handle: Locator, to: Locator | Pt) {
  // a connection is made on a handle (React Flow's connection radius is 20 px): aim at the target node's own target handle, else its middle
  const target = 'x' in to ? to : await (async () => {
    const t = to.locator('.react-flow__handle.target');
    return (await t.count()) > 0 ? centre(t.first()) : centre(to);
  })();
  const h0 = (await handle.boundingBox())!;
  await page.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2);
  await page.waitForTimeout(200);
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();
}
/** Step wire: from `from`'s right handle onto `to`. */
export const drawWire = (page: Page, from: Locator, to: Locator) => dragFromHandle(page, from.locator('.react-flow__handle.source'), to);
/** Entry arrow: from the triangle's tip onto a step. */
export const drawEntry = (page: Page, wf: Locator, step: Locator) => dragFromHandle(page, wf.locator('.react-flow__handle[data-handleid="tip"]'), step);
/** Cache link: from the triangle's back onto a cache. */
export const drawCacheLink = (page: Page, wf: Locator, cache: Locator) => dragFromHandle(page, wf.locator('.react-flow__handle[data-handleid="back"]'), cache);

/** A real mouse drag of `what` by (dx, dy) screen px, grabbed at its (gx, gy) offset (default: its middle). */
export async function dragBy(page: Page, what: Locator, dx: number, dy: number, grab?: Pt, release = true) {
  const b = (await what.boundingBox())!;
  const x = b.x + (grab?.x ?? b.width / 2), y = b.y + (grab?.y ?? b.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  if (release) await page.mouse.up();
}

/** Where a node is on the board, as React Flow placed it (flow units). */
export async function flowPos(l: Locator) {
  return l.evaluate((n) => {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec((n as HTMLElement).style.transform);
    return { x: Number(m?.[1] ?? 0), y: Number(m?.[2] ?? 0) };
  });
}

// ---- Toolbox drops -------------------------------------------------------------------------------------------------

/** Drops a toolbox item at the screen point; answers the id of the node that appeared (`wf:`, `st:` or `ca:`). */
export async function dropTool(page: Page, tool: Locator, kind: 'workflow' | 'step' | 'cache', at: Pt): Promise<string> {
  const sel = `.react-flow__node-${kind}`;
  const before = new Set(await page.locator(sel).evaluateAll((ns) => ns.map((n) => (n as HTMLElement).dataset.id)));
  await dragOnto(page, tool, at.x, at.y);
  await expect(page.locator(sel)).toHaveCount(before.size + 1);
  const now = await page.locator(sel).evaluateAll((ns) => ns.map((n) => (n as HTMLElement).dataset.id!));
  return now.find((i) => !before.has(i))!.replace(/^(wf|st|ca):/, '');
}

/** The screen point at (dx, dy) flow units from the region's corner as the view is now (zoom 1 views from openAt). */
export async function regionPoint(page: Page, rel: Pt): Promise<Pt> {
  const c = regionCorner();
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  const t = await page.evaluate(() => {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([\d.]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  });
  return { x: pane.x + t.x + (c.x + rel.x) * t.z, y: pane.y + t.y + (c.y + rel.y) * t.z };
}

/** Renames the picked row in the Inspector (the Name field) so it is an e2e- row; waits for the board to show it. */
export async function renameTo(page: Page, name: string) {
  await field(page, 'Name').fill(name);
}

/** Presses Save and waits until the whole Save (apply, read back, dry runs, diagrams) has finished. */
export async function save(page: Page) {
  await expect(saveButton(page)).toBeEnabled();
  await clearOutput(page);
  const sent = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/model/apply');
  await saveButton(page).click();
  const res = await sent;
  // the button says Saving… from the press until the read back, the dry runs and the diagrams are done
  await expect(saveButton(page)).not.toHaveText('Saving…', { timeout: 60_000 });
  const answer = (await res.json()) as { applied?: boolean; made?: Record<string, string> };
  // what Output said, kept with the test result
  test.info().annotations.push({ type: 'save', description: (await out(page).locator('[role="listitem"] span').allInnerTexts()).join(' | ').slice(0, 1500) });
  return answer;
}
