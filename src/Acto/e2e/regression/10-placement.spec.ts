import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  cacheTool, caNode, clear, dropTool, ghost, holdOver, openAt, pickStep, PROC_B, stNode, toolbar, toolboxStep, topAt, wfNode, workflowTool,
} from '../helpers';
import { seed } from '../seed';

// Regression 10 (user, 2026-11-25): placing items. Whatever is dragged is on top while it moves, whatever kind it is and
// whether or not it was picked, and what it lies over is outlined in amber with its name. A drop on another item (a ghost
// included) slides to the nearest place 16 px clear of everything; a drop that only comes near is left where it was let go.
// A new item dropped from the toolbox slides aside the same way, and an arrow nudge stops against a neighbour.

const SEED = {
  steps: [
    { key: 'A', name: 'e2e-pl-A', at: { x: 300, y: 60 } },
    { key: 'B', name: 'e2e-pl-B', at: { x: 620, y: 60 } },
    { key: 'G', name: 'e2e-pl-G', at: { x: 620, y: 420 } },
  ],
  caches: [{ key: 'C', name: 'e2e-pl-C', at: { x: 620, y: 260 } }],
  workflows: [{ key: 'W', name: 'e2e-pl-W', at: { x: 300, y: 260 }, entry: ['A'] }],
} as const;
const GAP = 16;
/** The amber of the "under" outline (--warn): light, then dark. */
const AMBER = { light: 'rgb(217, 119, 6)', dark: 'rgb(245, 184, 65)' } as const;
const markColour = (mark: Locator) => mark.evaluate((e) => getComputedStyle(e).borderTopColor);

/** Deletes G so a ghost of it stands on the board. */
async function makeGhost(page: Page, gId: string): Promise<Locator> {
  await pickStep(page, gId);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete' }).click();
  const g = ghost(page, 'e2e-pl-G');
  await expect(g).toHaveCount(1);
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  return g;
}
const box = async (l: Locator) => (await l.boundingBox())!;
/** The clear space between two boxes along the axis that separates them (negative when they overlap). */
async function spacing(a: Locator, b: Locator) {
  const p = await box(a), q = await box(b);
  const h = Math.max(q.x - (p.x + p.width), p.x - (q.x + q.width));
  const v = Math.max(q.y - (p.y + p.height), p.y - (q.y + q.height));
  return Math.max(h, v);
}

test('whatever is dragged is on top, and what it covers is named in amber', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const G = await makeGhost(page, id.G!);
  const [A, B, C, W] = [stNode(page, id.A!), stNode(page, id.B!), caNode(page, id.C!), wfNode(page, id.W!)];
  const name: Record<string, string> = { [`st:${id.A}`]: 'e2e-pl-A', [`st:${id.B}`]: 'e2e-pl-B', [`ca:${id.C}`]: 'e2e-pl-C', [`wf:${id.W}`]: 'e2e-pl-W' };
  // A paints below B, steps below caches, triangles below steps, ghosts below everything: each way round, the mover wins
  for (const [mover, target] of [[A, B], [B, A], [A, C], [C, A], [W, B], [G, B]] as const) {
    const start = await box(mover);
    const moverId = (await mover.getAttribute('data-id'))!;
    const targetId = (await target.getAttribute('data-id'))!;
    const at = await holdOver(page, mover, target);
    await expect.poll(() => topAt(page, at.x, at.y), `${moverId} over ${targetId}`).toBe(moverId);
    await expect(mover).toHaveClass(/\blifted\b/);
    const mark = page.locator(`[data-testid="under-mark"][data-under="${targetId}"]`);
    await expect(mark).toBeVisible();
    await expect(mark).toHaveText(`under: ${name[targetId]}`);
    expect(await markColour(mark), 'the outline is amber').toBe(AMBER.light);
    expect(await mark.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('dashed');
    if (!moverId.startsWith('ghost:')) expect(await mover.evaluate((e) => getComputedStyle(e).opacity)).toBe('0.82');
    // Esc cancels: no outline, the mover back where it started
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.getByTestId('under-mark')).toHaveCount(0);
    await expect.poll(async () => Math.round((await box(mover)).x)).toBe(Math.round(start.x));
    expect(Math.round((await box(mover)).y)).toBe(Math.round(start.y));
  }
  // in the dark theme too (the app's own toggle sets html[data-theme])
  await page.locator('button.theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await holdOver(page, A, B);
  const mark = page.locator(`[data-testid="under-mark"][data-under="st:${id.B}"]`);
  await expect(mark).toBeVisible();
  expect(await markColour(mark), 'the outline is amber in the dark theme').toBe(AMBER.dark);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('a drop slides clear by the gap; a drop that only comes near stays put', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const G = await makeGhost(page, id.G!);
  const [A, B] = [stNode(page, id.A!), stNode(page, id.B!)];

  // on top of B: slides off, a full gap clear
  await holdOver(page, A, B);
  await page.mouse.up();
  await expect.poll(() => clear(A, B)).toBe(true);
  expect(await spacing(A, B)).toBeGreaterThanOrEqual(GAP - 1);

  // 8 px left of B, level with it: inside the gap but not on it, so it stays where it was let go (left, not right: held near the
  // board's right edge React Flow auto-pans and the card keeps moving)
  const a = await box(A), b = await box(B);
  const want = { x: b.x - a.width - 8, y: b.y };
  const grab = { x: a.x + a.width / 2, y: a.y + 14 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  let ptr = { x: grab.x + (want.x - a.x), y: grab.y + (want.y - a.y) };
  await page.mouse.move(ptr.x, ptr.y, { steps: 12 });
  // React Flow's drag starts past a small threshold, so the card trails the pointer: nudge the pointer until the card sits there
  for (let i = 0; i < 6; i++) {
    const held = await box(A);
    if (Math.abs(held.x - want.x) < 0.6 && Math.abs(held.y - want.y) < 0.6) break;
    ptr = { x: ptr.x + (want.x - held.x), y: ptr.y + (want.y - held.y) };
    await page.mouse.move(ptr.x, ptr.y, { steps: 2 });
  }
  expect(Math.round((await box(A)).x), 'held 8 px left of B').toBe(Math.round(want.x));
  await page.mouse.up();
  // the drop is committed once the card is no longer lifted; a slide, had there been one, starts in that same render
  await expect(A).not.toHaveClass(/\blifted\b/);
  await expect(A, 'a near drop starts no slide').not.toHaveClass(/\bsettling\b/);
  await page.waitForTimeout(400); // longer than a slide (280 ms), so a late one would have moved it
  expect(Math.round((await box(A)).x), 'stays where it was let go').toBe(Math.round(want.x));
  expect(Math.round((await box(A)).y)).toBe(Math.round(want.y));

  // ghosts take part both ways
  await holdOver(page, A, G);
  await page.mouse.up();
  await expect.poll(() => clear(A, G)).toBe(true);
  await holdOver(page, G, B);
  await page.mouse.up();
  await expect.poll(() => clear(G, B)).toBe(true);
});

test('toolbox drops slide aside; nudges stop against a neighbour', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const [A, B] = [stNode(page, id.A!), stNode(page, id.B!)];
  const b = await box(B);
  const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const step = await dropTool(page, toolboxStep(page, PROC_B), 'step', centre);
  await expect.poll(() => clear(stNode(page, step), B)).toBe(true);
  const wf = await dropTool(page, workflowTool(page), 'workflow', centre);
  await expect.poll(() => clear(wfNode(page, wf), B)).toBe(true);
  const cache = await dropTool(page, cacheTool(page), 'cache', centre);
  await expect.poll(() => clear(caNode(page, cache), B)).toBe(true);

  // A is level with B, about 110 px short of it: 30 nudges of 8 px would carry it well onto B, so it must stop
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  const x0 = (await box(A)).x;
  await pickStep(page, id.A!);
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await box(A)).x).toBeGreaterThan(x0 + 40);
  expect(await clear(A, B)).toBe(true);
  const x1 = (await box(A)).x;
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await box(A)).x).toBeLessThan(x1);
});
