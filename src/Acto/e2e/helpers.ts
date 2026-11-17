import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures';

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

/** An empty spot on the board: a point (with room for a new frame) whose topmost element is the pane. */
export async function findEmptySpot(page: Page) {
  return page.evaluate(() => {
    const board = document.querySelector('.react-flow')!.getBoundingClientRect();
    const zoom = Number(/scale\(([\d.]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)?.[1] ?? 1);
    const w = 420 * zoom, h = 260 * zoom;
    for (let y = board.top + 80; y < board.bottom - h; y += 20) {
      for (let x = board.left + 20; x < board.right - w; x += 20) {
        let free = true;
        for (const dx of [-16, 0, w / 2, w + 16]) for (const dy of [-16, 0, h / 2, h + 16]) {
          const el = document.elementFromPoint(x + dx, y + dy);
          if (!el || !el.classList.contains('react-flow__pane')) free = false;
        }
        if (free) return { x, y };
      }
    }
    return null;
  });
}

export const LOADED = /Board loaded: \d+ workflows?/;
export const out = (page: Page) => page.locator('[data-panel="output"]');
/** An Output line with exactly this text (or matching this pattern). */
export const outLine = (page: Page, text: string | RegExp) =>
  out(page).locator('[role="listitem"] span').filter({ hasText: typeof text === 'string' ? new RegExp(`^${escapeRe(text)}$`) : text });
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const zoomOf = (page: Page) => page.evaluate(() =>
  Number(/scale\(([\d.]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)?.[1] ?? 1));

/** The board after a load: every workflow in, and the first fit done. */
export async function openBoard(page: Page) {
  // the fitted view, not one remembered from an earlier load in this test
  if (page.url().startsWith('http')) await page.evaluate(() => localStorage.removeItem('acto.view'));
  await page.goto('/');
  await waitLoaded(page);
}

export async function waitLoaded(page: Page) {
  await expect(outLine(page, LOADED)).toHaveCount(1);
  await expect(page.locator('.react-flow__node-workflow').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform))
    .not.toBe('translate(0px, 0px) scale(1)');
  await page.waitForTimeout(250);
}

/** Every frame's board rectangle, read from the nodes React Flow drew. */
export async function frameRects(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.react-flow__node-workflow')].map((n) => {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(n.style.transform);
    return { id: (n.dataset.id ?? '').replace(/^wf:/, ''), x: Number(m?.[1] ?? 0), y: Number(m?.[2] ?? 0), w: n.offsetWidth, h: n.offsetHeight };
  }));
}

/**
 * Opens the board with the view on empty paper right of every frame, at `zoom`: the remembered view (acto.view) is set
 * and the page reloaded, so throwaway frames can be dropped where nothing else is.
 */
export async function openEmptyBoard(page: Page, zoom = 1) {
  await openBoard(page);
  const rects = await frameRects(page);
  const right = Math.max(0, ...rects.map((r) => r.x + r.w));
  const top = Math.min(0, ...rects.map((r) => r.y));
  await page.evaluate(({ x, y, zoom }) => localStorage.setItem('acto.view', JSON.stringify({ x, y, zoom, selection: null })),
    { x: -(right + 400) * zoom, y: -top * zoom + 20, zoom });
  await page.reload();
  await waitLoaded(page);
  await expect.poll(() => findEmptySpot(page)).not.toBeNull();
}

/** The middle of an empty stretch of board (not a frame, not the minimap or the controls). */
export async function emptyPoint(page: Page) {
  const spot = await findEmptySpot(page);
  expect(spot, 'an empty spot on the board').not.toBeNull();
  return { x: spot!.x + 100, y: spot!.y + 60 };
}

export const paneBox = async (page: Page) => (await page.locator('.react-flow__pane').boundingBox())!;

export interface Frame { id: string; name: string; frame: Locator }

export const frameOf = (page: Page, id: string) => page.locator(`.react-flow__node-workflow[data-id="wf:${id}"]`);
export const stepsOf = (page: Page, id: string) => page.locator(`.react-flow__node-step[data-id^="st:${id}:"]`);
export const cachesOf = (page: Page, id: string) => page.locator(`.react-flow__node-cache[data-id^="ca:${id}:"]`);
export const wiresOf = (page: Page, id: string) => page.locator(`.react-flow__edge[data-id^="wi:${id}:"]`);
export const toolbar = (page: Page, kind: 'workflow' | 'step' | 'wire' | 'cache') => page.getByRole('toolbar', { name: `${kind} actions` });
export const selbar = (page: Page) => page.getByRole('toolbar', { name: 'selection actions' });
export const inspector = (page: Page) => page.locator('[data-panel="inspector"]');
export const field = (page: Page, label: string) => inspector(page).locator('label.fld', { has: page.locator(`span`, { hasText: new RegExp(`^${escapeRe(label)}$`) }) }).locator('input, textarea, select');
export const toolboxStep = (page: Page, processor: string) =>
  page.getByTestId('toolbox-step').filter({ has: page.locator('.tx', { hasText: new RegExp(`^${escapeRe(processor)}`) }) }).first();
export const workflowTool = (page: Page) => page.getByRole('button', { name: /Workflow\s*drop on empty board/ });
export const cacheTool = (page: Page) => page.getByRole('button', { name: /Cache\s*drop inside a workflow/ });

/** Drops a new workflow at the screen point (or the first empty spot); answers its id, name and frame. */
export async function dropWorkflow(page: Page, at?: { x: number; y: number }): Promise<Frame> {
  const before = new Set(await page.locator('.react-flow__node-workflow').evaluateAll((ns) => ns.map((n) => (n as HTMLElement).dataset.id)));
  const spot = at ?? await findEmptySpot(page);
  expect(spot, 'an empty spot on the board').not.toBeNull();
  await dragOnto(page, workflowTool(page), spot!.x, spot!.y);
  await expect(page.locator('.react-flow__node-workflow')).toHaveCount(before.size + 1);
  const ids = await page.locator('.react-flow__node-workflow').evaluateAll((ns) => ns.map((n) => (n as HTMLElement).dataset.id));
  const id = ids.find((i) => !before.has(i))!.replace(/^wf:/, '');
  const frame = frameOf(page, id);
  const name = (await frame.locator('.nm').textContent())!;
  return { id, name, frame };
}

/** Drops a step of `processor` into the frame, its top-left at (dx, dy) screen px from the frame's content corner. */
export async function dropStep(page: Page, f: Frame, processor: string, dx: number, dy: number) {
  const n = await stepsOf(page, f.id).count();
  const fb = (await f.frame.boundingBox())!;
  const zoom = await zoomOf(page);
  await dragOnto(page, toolboxStep(page, processor), fb.x + dx, fb.y + 46 * zoom + dy);
  await expect(stepsOf(page, f.id)).toHaveCount(n + 1);
  const ids = await stepsOf(page, f.id).evaluateAll((ns) => ns.map((x) => (x as HTMLElement).dataset.id!));
  return page.locator(`.react-flow__node-step[data-id="${ids[ids.length - 1]}"]`);
}

/** A real mouse drag from `from`'s right handle onto the middle of `to` (or onto a page point). */
export async function drawWire(page: Page, from: Locator, to: Locator | { x: number; y: number }) {
  const handle = from.locator('.react-flow__handle.source');
  const target = 'x' in to ? to : await (async () => { const b = (await to.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })();
  // the card's hover grows its handles and (see create.spec.ts) shifts the right one: aim at where it is drawn once hovered
  const h0 = (await handle.boundingBox())!;
  await page.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2);
  await page.waitForTimeout(200);
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();
}

/** A real mouse drag of `what` by (dx, dy) screen px, grabbed at its (gx, gy) offset (default: its middle). */
export async function dragBy(page: Page, what: Locator, dx: number, dy: number, grab?: { x: number; y: number }, release = true) {
  const b = (await what.boundingBox())!;
  const x = b.x + (grab?.x ?? b.width / 2), y = b.y + (grab?.y ?? b.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  if (release) await page.mouse.up();
}

/** Clicks the frame's header (the name), with Ctrl when `add`. */
export async function pickFrame(f: Locator, add = false) {
  await f.locator('.nm').click(add ? { modifiers: ['Control'] } : {});
}
/** Clicks a step card on its name line, with Ctrl when `add`. */
export async function pickStep(s: Locator, add = false) {
  await s.locator('.sn').click(add ? { modifiers: ['Control'] } : {});
}
/** Clicks a wire on the middle of its curve (its wide hit path), with Ctrl when `add`. */
export async function pickWire(page: Page, w: Locator, add = false) {
  const p = await w.locator('path.wire-hit').evaluate((el) => {
    const path = el as SVGPathElement;
    const pt = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  });
  if (add) await page.keyboard.down('Control');
  await page.mouse.click(p.x, p.y);
  if (add) await page.keyboard.up('Control');
}

/** A fresh, empty board area with one throwaway workflow and `steps` steps of `processor` side by side. */
export async function throwaway(page: Page, steps = 0, processor = PROC_A): Promise<Frame & { steps: Locator[] }> {
  const f = await dropWorkflow(page);
  const out: Locator[] = [];
  for (let i = 0; i < steps; i++) out.push(await dropStep(page, f, processor, 30 + i * 260, 30 + (i % 2) * 40));
  return { ...f, steps: out };
}

/** The processors the specs drop as steps (never edited or saved as processors). */
export const PROC_A = 'archive-expander';
export const PROC_B = 'sk-normalizer';
