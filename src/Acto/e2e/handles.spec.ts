import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { caNode, clickEmptyBoard, openAt, pickStep, pickWorkflow, stNode, wfNode } from './helpers';
import { seed } from './seed';

// [user, 2026-11-19] "when I hover a component two red dots appear but hovering above them not always modifies the cursor to a
// cross; it happens a lot on the triangle". A person's mouse is moved from the item's body onto points across each visible dot
// (its centre and the four sides of its circle), in every state the dots are seen in; the element under the pointer must be
// the handle and the cursor a crosshair. Nothing is edited or saved.

const SEED = {
  steps: [
    { key: 's1', name: 'e2e-hd-first', at: { x: 300, y: 80 }, next: ['s2'] },
    { key: 's2', name: 'e2e-hd-second', at: { x: 620, y: 80 } },
  ],
  caches: [{ key: 'c1', name: 'e2e-hd-cache', at: { x: 40, y: 330 } }],
  workflows: [
    // A: an entry arrow from its tip and a cache line from its back, the two lines that start at its dots
    { key: 'a', name: 'e2e-hd-a', at: { x: 0, y: 60 }, entry: ['s1'], caches: ['c1'] },
    // B: an entry arrow only (BaseAPI refuses a workflow without one), no cache line
    { key: 'b', name: 'e2e-hd-b', at: { x: 0, y: 470 }, entry: ['s2'] },
  ],
} as const;

/** Points on the visible dot (in dot widths from its centre). */
const ON: [number, number][] = [[0, 0], [-0.35, 0], [0.35, 0], [0, -0.35], [0, 0.35]];
/** Points beside the dot, outside its visible circle (one dot width from its centre): inside the catch zone [user, 2026-11-19]. */
const NEAR: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** What is under the pointer, and its cursor, after the mouse comes from `from` onto each point of the dot. */
async function underDot(page: Page, dot: Locator, from: Locator, offsets: [number, number][]): Promise<string[]> {
  const r = (await dot.boundingBox())!;
  const b = (await from.boundingBox())!;
  const misses: string[] = [];
  for (const [dx, dy] of offsets) {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.move(r.x + r.width / 2 + dx * r.width, r.y + r.height / 2 + dy * r.height, { steps: 6 });
    const got = await page.evaluate(() => {
      const el = [...document.querySelectorAll(':hover')].at(-1);
      if (!el) return { on: false, what: 'nothing', cursor: '-' };
      return {
        on: el.classList.contains('react-flow__handle'),
        what: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}${el.closest('.react-flow__edge') ? ` in edge ${el.closest('.react-flow__edge')!.getAttribute('data-id')}` : ''}`,
        cursor: getComputedStyle(el).cursor,
      };
    });
    if (!got.on || got.cursor !== 'crosshair') misses.push(`${dx},${dy}: ${got.what} cursor=${got.cursor}`);
  }
  return misses;
}

async function expectCrosshairs(page: Page, item: Locator, body: Locator, dots: string[], state: string, offsets = ON) {
  for (const sel of dots) {
    const misses = await underDot(page, item.locator(sel), body, offsets);
    expect(misses, `${state}, dot ${sel}`).toEqual([]);
  }
}

const TRI_DOTS = ['.react-flow__handle[data-handleid="tip"]', '.react-flow__handle[data-handleid="back"]'];

test('a triangle\'s two dots show the crosshair at every point: with and without lines, unselected, selected, multi-selected', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  for (const k of ['a', 'b'] as const) {
    const tri = wfNode(page, id[k]!);
    const body = tri.locator('.tri-shape');
    await clickEmptyBoard(page);
    await expectCrosshairs(page, tri, body, TRI_DOTS, `${k} unselected`);
    await pickWorkflow(page, id[k]!);
    await expect(tri.locator('.tri.sel')).toHaveCount(1);
    await expectCrosshairs(page, tri, body, TRI_DOTS, `${k} selected alone`);
  }
  // both triangles picked (pick numbers drawn) and a step
  await clickEmptyBoard(page);
  await pickWorkflow(page, id.a!);
  await wfNode(page, id.b!).locator('.tri-nm').click({ modifiers: ['Control'] });
  await pickStep(page, id.s1!);
  for (const k of ['a', 'b'] as const) await expectCrosshairs(page, wfNode(page, id[k]!), wfNode(page, id[k]!).locator('.tri-shape'), TRI_DOTS, `${k} multi-selected`);
});

test('a step\'s dots and a cache\'s dot: the crosshair wherever a line can start or end', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  for (const k of ['s1', 's2'] as const) {
    const step = stNode(page, id[k]!);
    await clickEmptyBoard(page);
    await expectCrosshairs(page, step, step.locator('.sn'), ['.react-flow__handle.source', '.react-flow__handle.target'], `${k} unselected`);
    await pickStep(page, id[k]!);
    await expectCrosshairs(page, step, step.locator('.sn'), ['.react-flow__handle.source', '.react-flow__handle.target'], `${k} selected`);
  }
  const cache = caNode(page, id.c1!);
  await clickEmptyBoard(page);
  await expectCrosshairs(page, cache, cache.locator('.cache-nm'), ['.react-flow__handle'], 'cache');
});

for (const zoom of [1, 0.5]) {
  test(`[user, 2026-11-19] at zoom ${zoom}, beside the dot (outside its visible circle) still shows the crosshair: triangles, steps, a cache`, async ({ page }) => {
    const id = await seed(SEED);
    await openAt(page, { x: 0, y: 0 }, zoom);
    for (const k of ['a', 'b'] as const) {
      const tri = wfNode(page, id[k]!);
      await clickEmptyBoard(page);
      await expectCrosshairs(page, tri, tri.locator('.tri-shape'), TRI_DOTS, `${k} near`, NEAR);
    }
    for (const k of ['s1', 's2'] as const) {
      const step = stNode(page, id[k]!);
      await expectCrosshairs(page, step, step.locator('.sn'), ['.react-flow__handle.source', '.react-flow__handle.target'], `${k} near`, NEAR);
    }
    const cache = caNode(page, id.c1!);
    await expectCrosshairs(page, cache, cache.locator('.cache-nm'), ['.react-flow__handle'], 'cache near', NEAR);
  });
}

test("[user, 2026-11-19] a triangle's dots grow on hover like a step's", async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const tri = wfNode(page, id.a!);
  const tip = tri.locator('.react-flow__handle[data-handleid="tip"]');
  await clickEmptyBoard(page);
  const before = (await tip.boundingBox())!.width;
  const b = (await tri.locator('.tri-shape').boundingBox())!;
  await page.mouse.move(b.x + b.width / 3, b.y + b.height / 2);
  await expect.poll(async () => (await tip.boundingBox())!.width / before).toBeCloseTo(1.3, 1);
});
