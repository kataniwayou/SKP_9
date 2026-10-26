import type { Locator, Page } from '@playwright/test';
import { documentPanel, edge, expect, flowToPage, node, openWorkflow, test } from './studio';
import { createDrawingThrowaway, removeThrowaway, type DrawingThrowaway } from './throwaway';

// The rectangle picks what it touches, wholly or in part (the user's, 2026-10-26), with the real mouse on the drawing
// throwaway (`e2e-dg-…`, its routes stored, so a wire's runs lie where the tests say). Nothing is saved.
test.describe.configure({ mode: 'default', retries: 0 });
let t: DrawingThrowaway;
test.beforeAll(async ({ request }) => { t = await createDrawingThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** A plain left drag on empty canvas from flow point `a` to `b`: the rectangle. */
async function band(page: Page, panel: Locator, a: [number, number], b: [number, number]): Promise<void> {
  const p = await flowToPage(panel, a), q = await flowToPage(panel, b);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 });
  await page.mouse.move(q.x, q.y, { steps: 4 });
  await page.mouse.up();
}

/** The picked blocks' node ids and picked wires' ids, sorted. */
const picks = (panel: Locator) => panel.evaluate((root) => [
  ...[...root.querySelectorAll('.react-flow__node.studio-pick')].map((e) => `node:${e.getAttribute('data-id')}`),
  ...[...root.querySelectorAll('.react-flow__edge')].filter((e) => /\bpicked\b/.test(e.querySelector('.wire')?.getAttribute('class') ?? '')).map((e) => `wire:${e.getAttribute('data-id')}`),
].sort());

test('a rectangle over the bottom-left corner of h1 picks h1, though most of it lies outside', async ({ page }) => {
  const panel = await open(page);
  // h1: (352, 256) to (576, 416); the press below and left of it, on empty canvas (the top row lies under the panel's title)
  await band(page, panel, [320, 448], [368, 400]);
  await expect.poll(() => picks(panel)).toEqual([`node:${t.h1}`]);
  await expect(node(panel, t.h1)).toHaveClass(/studio-pick/);
});

test('a rectangle across the middle of a wire run, off every block, picks that wire alone', async ({ page }) => {
  const panel = await open(page);
  // h1 -> h3 runs level at y 192 from x 672 to 1056, above the row
  await band(page, panel, [848, 176], [880, 208]);
  await expect.poll(() => picks(panel)).toEqual([`wire:${t.h1}->${t.h3}`]);
  await expect(edge(panel, `${t.h1}->${t.h3}`).locator('.wire')).toHaveClass(/picked/);
});

test('the hub is picked when the rectangle reaches its circle, not its box corner outside it', async ({ page }) => {
  const panel = await open(page);
  // the hub's circle: centre (128, 336), radius 96; (24..44, 420..440) is over its box's corner, outside the circle
  await band(page, panel, [24, 440], [44, 420]);
  await expect.poll(() => picks(panel)).toEqual([]);
  await band(page, panel, [120, 444], [136, 424]);
  await expect.poll(() => picks(panel)).toEqual(['node:wf']);
});

test('a rectangle half over h1 and h2 picks both and the wires it crosses', async ({ page }) => {
  const panel = await open(page);
  // from empty canvas below h1 to inside h2: just over h1's right edge (576) and h2's left (736), and every run in between
  await band(page, panel, [560, 600], [760, 300]);
  const got = await picks(panel);
  expect(got).toEqual(expect.arrayContaining([`node:${t.h1}`, `node:${t.h2}`, `wire:${t.h1}->${t.h2}`, `wire:${t.h1}->${t.h3}`, `wire:${t.h1}->${t.h4}`, `wire:wf->${t.h2}`, `wire:wf->${t.h3}`]));
  expect(got).not.toContain(`node:${t.h3}`);
});
