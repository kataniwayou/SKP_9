import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { caNode, ghost, openAt, pickStep, stNode, toolbar, wfNode } from './helpers';
import { seed } from './seed';

// Option B of the drag mock [user, 2026-11-25]: a dragged item is always on top while it moves, what it lies over is
// outlined in amber with its name, and a drop on another item (a ghost included) slides to the nearest free place, so the
// board never ends with one item hiding another. Before this, the paint order (triangles < steps < caches) decided.

const SEED = {
  steps: [
    { key: 'a', name: 'e2e-ov-step-A', at: { x: 300, y: 60 } },
    { key: 'b', name: 'e2e-ov-step-B', at: { x: 620, y: 60 } },
    { key: 'g', name: 'e2e-ov-ghost', at: { x: 620, y: 420 } },
  ],
  caches: [{ key: 'c', name: 'e2e-ov-cache', at: { x: 620, y: 260 } }],
  workflows: [{ key: 'w', name: 'e2e-ov-wf', at: { x: 300, y: 260 }, entry: ['a'] }],
} as const;

/** The node whose element is on top at a screen point. */
const topAt = (page: Page, x: number, y: number) => page.evaluate(([px, py]) =>
  (document.elementFromPoint(px!, py!)?.closest('.react-flow__node') as HTMLElement | null)?.dataset.id ?? null, [x, y]);

/** Holds `mover` with its centre on `target`'s centre; answers that point. The caller lets go. */
async function holdOver(page: Page, mover: Locator, target: Locator) {
  const m = (await mover.boundingBox())!;
  const t = (await target.boundingBox())!;
  const grab = { x: m.x + m.width / 2, y: m.y + Math.min(14, m.height / 2) };
  const to = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + to.x - (m.x + m.width / 2), grab.y + to.y - (m.y + m.height / 2), { steps: 12 });
  return to;
}

const clear = async (a: Locator, b: Locator) => {
  const p = (await a.boundingBox())!, q = (await b.boundingBox())!;
  return p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y;
};

test('a dragged item is on top of whatever it crosses, in either order and picked or not', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const A = stNode(page, id.a!), B = stNode(page, id.b!), C = caNode(page, id.c!), W = wfNode(page, id.w!);
  // each pair, both ways: the one being dragged is the one seen (A paints below B, steps below caches, triangles below steps)
  for (const [mover, target] of [[A, B], [B, A], [A, C], [C, A], [W, B]] as const) {
    const at = await holdOver(page, mover, target);
    await expect.poll(() => topAt(page, at.x, at.y)).toBe(await mover.getAttribute('data-id'));
    await expect(mover).toHaveClass(/\blifted\b/);
    // what it lies over is outlined above it, with its name
    await expect(page.locator(`[data-testid="under-mark"][data-under="${await target.getAttribute('data-id')}"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.getByTestId('under-mark')).toHaveCount(0);
  }
  // a picked item elsewhere does not outrank the one being dragged
  await pickStep(page, id.b!);
  const at = await holdOver(page, A, B);
  await expect.poll(() => topAt(page, at.x, at.y)).toBe(`st:${id.a}`);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('a drop on another item slides to a free place beside it, so neither hides the other', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const A = stNode(page, id.a!), B = stNode(page, id.b!), C = caNode(page, id.c!);
  await holdOver(page, A, B);
  await expect(page.locator(`[data-testid="under-mark"][data-under="st:${id.b}"]`)).toContainText('under: e2e-ov-step-B');
  await page.mouse.up();
  await expect.poll(() => clear(A, B)).toBe(true);
  await expect(A).not.toHaveClass(/\blifted\b/);
  // a cache dropped on a step clears it too
  await holdOver(page, C, A);
  await page.mouse.up();
  await expect.poll(() => clear(C, A)).toBe(true);
});

test('ghosts take part: a drop on a ghost slides aside, and a dragged ghost slides off a real item', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickStep(page, id.g!);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete' }).click();
  const G = ghost(page, 'e2e-ov-ghost');
  await expect(G).toHaveCount(1);
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  const A = stNode(page, id.a!);

  // a real step dropped on the ghost
  const at = await holdOver(page, A, G);
  await expect.poll(() => topAt(page, at.x, at.y)).toBe(`st:${id.a}`);
  await expect(page.locator(`[data-testid="under-mark"][data-under^="ghost:"]`)).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => clear(A, G)).toBe(true);

  // the ghost dropped on a real step: on top while dragged, then off it
  const B = stNode(page, id.b!);
  const at2 = await holdOver(page, G, B);
  await expect.poll(() => topAt(page, at2.x, at2.y)).toMatch(/^ghost:/);
  await page.mouse.up();
  await expect.poll(() => clear(G, B)).toBe(true);
});
