import { test, expect } from './fixtures';
import {
  cacheTool, caNode, clear, dropTool, ghost, holdOver, openAt, pickStep, PROC_B, stNode, toolbar, toolboxStep, topAt, wfNode, workflowTool,
} from './helpers';
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

test('a new item dropped from the toolbox onto another slides aside too [user, 2026-11-25]', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const B = stNode(page, id.b!);
  const t = (await B.boundingBox())!;
  const made = await dropTool(page, toolboxStep(page, PROC_B), 'step', { x: t.x + t.width / 2, y: t.y + t.height / 2 });
  await expect.poll(() => clear(stNode(page, made), B)).toBe(true);
  // a triangle and a cache dropped on it as well
  const w = await dropTool(page, workflowTool(page), 'workflow', { x: t.x + t.width / 2, y: t.y + t.height / 2 });
  await expect.poll(() => clear(wfNode(page, w), B)).toBe(true);
  const c = await dropTool(page, cacheTool(page), 'cache', { x: t.x + t.width / 2, y: t.y + t.height / 2 });
  await expect.poll(() => clear(caNode(page, c), B)).toBe(true);
});

test('arrow nudges stop against another item instead of going over it [user, 2026-11-25]', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const A = stNode(page, id.a!), B = stNode(page, id.b!);
  const x0 = (await A.boundingBox())!.x;
  await pickStep(page, id.a!);
  // A's right edge is ~110 px short of B: 30 nudges of 8 px would carry it well onto B
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await A.boundingBox())!.x).toBeGreaterThan(x0 + 40);
  expect(await clear(A, B)).toBe(true);
  // and back the other way it moves freely
  const x1 = (await A.boundingBox())!.x;
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await A.boundingBox())!.x).toBeLessThan(x1);
});
